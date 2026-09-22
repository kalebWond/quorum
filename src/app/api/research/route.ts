import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  createRunEmitter,
  encodeSSE,
  type RunEvent,
  type RunEventBody,
} from "@/lib/events";
import { PlanError, runPlanner } from "@/lib/plan";
import { ResearchError, runResearcher } from "@/lib/research";

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
  if (error instanceof ResearchError || error instanceof PlanError) {
    return error.message;
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return "The server's API key was rejected.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Rate limited — please try again in a moment.";
  }
  if (error instanceof Anthropic.APIError) {
    return `The model request failed (${error.status}).`;
  }
  return "Something went wrong while researching.";
}

/**
 * Feature 3: planner then researcher, streamed over SSE.
 *
 * The agents live in `lib/plan.ts` and `lib/research.ts`; this route owns only
 * the orchestration and the transport — the event schema, the `id:` sequence,
 * and the guarantee that a failure always reaches the client as `run_failed`
 * rather than a hung spinner.
 */
export async function POST(request: Request) {
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
  const plannerId = crypto.randomUUID();
  const researcherId = crypto.randomUUID();
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

      // Whoever is mid-flight owns a failure, so the UI marks the right card.
      let activeAgentId = plannerId;

      try {
        send(emit({ type: "run_started", question }));

        // Plan first. The sub-questions steer the researcher now and become
        // one researcher each in Feature 4.
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
        );
        send(emit({ type: "plan_ready", subQuestions: plan.subQuestions }));
        send(
          emit({
            type: "agent_finished",
            agentId: plannerId,
            summary: `Split into ${plan.subQuestions.length} sub-questions.`,
          }),
        );

        activeAgentId = researcherId;
        send(
          emit({
            type: "agent_started",
            agentId: researcherId,
            role: "researcher",
            label: "Researcher",
          }),
        );
        const result = await runResearcher(
          question,
          researcherId,
          relay,
          request.signal,
          plan.subQuestions,
        );

        if (!request.signal.aborted) {
          send(
            emit({
              type: "agent_finished",
              agentId: researcherId,
              summary:
                result.sources.length === 0
                  ? "Answered without reading a source."
                  : `Read ${result.sources.length} source${
                      result.sources.length === 1 ? "" : "s"
                    }.`,
            }),
          );
          send(emit({ type: "run_finished" }));
        }
      } catch (error) {
        // The client hung up. Nothing is listening, so emit nothing and let
        // `finally` close the stream.
        if (request.signal.aborted) return;

        // A stream that dies silently leaves the UI on a spinner forever, so
        // every failure path has to produce a terminal event first.
        console.error(`[run ${runId}] failed`, error);
        const message = toClientError(error);
        send(
          emit({
            type: "agent_failed",
            agentId: activeAgentId,
            error: message,
          }),
        );
        send(emit({ type: "run_failed", error: message }));
      } finally {
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
