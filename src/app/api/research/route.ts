import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  createRunEmitter,
  encodeSSE,
  type RunEvent,
  type RunEventBody,
} from "@/lib/events";
import { BudgetError, RunBudget } from "@/lib/budget";
import { PlanError, runPlanner } from "@/lib/plan";
import { ResearchError, runResearchers } from "@/lib/research";
import { describeReset, rateLimiter, visitorKey } from "@/lib/rate-limit";
import { runWriter, WriteError } from "@/lib/write";

// The Anthropic SDK streams over Node APIs, and this route is long-lived.
export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.object({
  question: z.string().trim().min(1, "Ask a question first.").max(2000),
});

/**
 * Turns an exception into something safe to show a visitor.
 *
 * The raw SDK error carries status text, request ids, and provider detail that
 * belongs in the server log, not in a public demo's UI.
 */
function toClientError(error: unknown): string {
  // Raised deliberately by an agent, and already phrased for a visitor.
  if (
    error instanceof ResearchError ||
    error instanceof PlanError ||
    error instanceof WriteError ||
    error instanceof BudgetError
  ) {
    return error.message;
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return "The server's API key was rejected.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Rate limited — please try again in a moment.";
  }
  // A 400 from the provider is a problem with this deployment, not with the
  // visitor's question — an exhausted credit balance lands here. Saying "the
  // model request failed (400)" tells them nothing they can act on, so point
  // them at the thing that does work.
  if (error instanceof Anthropic.BadRequestError) {
    return (
      "Quorum cannot run new research right now. " +
      'Use "Watch a sample run" to see a finished run in full.'
    );
  }
  if (error instanceof Anthropic.APIError) {
    return `The model request failed (${error.status}).`;
  }
  return "Something went wrong while researching.";
}

/**
 * Feature 5: a planner, parallel researchers, then a writer, over SSE.
 *
 * The agents live in `lib/plan.ts` and `lib/research.ts`; this route owns only
 * the orchestration and the transport — the event schema, the `id:` sequence,
 * and the guarantee that a run always reaches a terminal event rather than
 * leaving the UI on a spinner.
 */
export async function POST(request: Request) {
  // Checked before anything else: a refused visitor must cost nothing.
  const limit = rateLimiter.check(visitorKey(request.headers));
  if (!limit.allowed) {
    return Response.json(
      {
        error:
          `You have used your runs for now — the limit resets ${describeReset(limit.resetInMs)}. ` +
          `In the meantime, "Watch a sample run" replays a finished run in full.`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(limit.resetInMs / 1000)) },
      },
    );
  }

  let question: string;
  try {
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request." },
        { status: 400 },
      );
    }
    question = parsed.data.question;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const runId = crypto.randomUUID();
  // One budget shared by every agent in the run — the ceiling that does not
  // leak across serverless instances the way the rate limiter does.
  const budget = new RunBudget();
  const plannerId = crypto.randomUUID();
  const writerId = crypto.randomUUID();
  const emit = createRunEmitter(runId);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: RunEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(encodeSSE(event)));
      };

      const relay = (body: RunEventBody) => send(emit(body));

      // Set while a single named agent owns the work. Cleared once the
      // researchers take over, since each of them reports its own failure.
      let soleAgentId: string | null = plannerId;

      try {
        send(emit({ type: "run_started", question }));

        // Plan first: the sub-questions become one researcher each.
        send(
          emit({
            type: "agent_started",
            agentId: plannerId,
            role: "planner",
            label: "Planner",
          }),
        );
        const plan = await runPlanner(
          question,
          plannerId,
          relay,
          request.signal,
          budget,
        );
        soleAgentId = null;
        send(emit({ type: "plan_ready", subQuestions: plan.subQuestions }));
        send(
          emit({
            type: "agent_finished",
            agentId: plannerId,
            summary: `Split into ${plan.subQuestions.length} sub-questions.`,
          }),
        );

        // One researcher per sub-question, in parallel. Each owns its own
        // failure, so the run reports what is missing instead of dying.
        const outcomes = await runResearchers(
          plan.subQuestions,
          relay,
          request.signal,
          budget,
        );

        if (!request.signal.aborted) {
          const failed = outcomes.filter((outcome) => !outcome.ok);

          if (failed.length === outcomes.length) {
            // Nothing survived. There is no partial result to show, so this is
            // a run failure rather than a run with gaps.
            throw new ResearchError(
              "Every researcher failed, so there is nothing to report.",
            );
          }

          if (failed.length > 0) {
            send(
              emit({
                type: "run_incomplete",
                missing: failed.map((outcome) => outcome.subQuestion),
              }),
            );
          }

          // The writer is a single named agent again, so it owns a failure.
          soleAgentId = writerId;
          send(
            emit({
              type: "agent_started",
              agentId: writerId,
              role: "writer",
              label: "Writer",
            }),
          );
          const report = await runWriter(
            question,
            outcomes,
            writerId,
            relay,
            request.signal,
            budget,
          );

          if (!request.signal.aborted) {
            send(
              emit({
                type: "report_ready",
                markdown: report.markdown,
                sources: report.cited,
                rejected: report.rejected,
              }),
            );
            send(
              emit({
                type: "agent_finished",
                agentId: writerId,
                summary: `Cited ${report.cited.length} of ${report.sources.length} sources.`,
              }),
            );
            send(emit({ type: "run_finished" }));
          }
        }
      } catch (error) {
        // The client hung up. Nothing is listening, so emit nothing and let
        // `finally` close the stream.
        if (request.signal.aborted) return;

        // A stream that dies silently leaves the UI on a spinner forever, so
        // every failure path has to produce a terminal event first.
        console.error(`[run ${runId}] failed`, error);
        const message = toClientError(error);
        if (soleAgentId) {
          send(
            emit({
              type: "agent_failed",
              agentId: soleAgentId,
              error: message,
            }),
          );
        }
        send(emit({ type: "run_failed", error: message }));
      } finally {
        const spent = budget.snapshot();
        console.log(
          `[run ${runId}] $${spent.usd.toFixed(4)} of $${spent.limits.usd.toFixed(2)}, ` +
            `${spent.calls}/${spent.limits.calls} calls, ` +
            `${(spent.elapsedMs / 1000).toFixed(1)}s`,
        );
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // `no-transform` keeps proxies from buffering the stream into one blob.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
