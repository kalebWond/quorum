import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getAnthropic, MODEL } from "@/lib/anthropic";
import { createRunEmitter, encodeSSE, type RunEvent } from "@/lib/events";

// The Anthropic SDK streams over Node APIs, and this route is long-lived.
export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.object({
  question: z.string().trim().min(1, "Ask a question first.").max(2000),
});

const SYSTEM_PROMPT = [
  "You are the research agent for Quorum.",
  "Answer the user's question directly and concisely.",
  "State plainly when something is uncertain or when you would need to look it up —",
  "do not invent specifics, and do not cite sources you have not actually read.",
].join(" ");

/**
 * Turns an exception into something safe to show a visitor.
 *
 * The raw SDK error carries status text, request ids, and provider detail that
 * belongs in the server log, not in a public demo's UI.
 */
function toClientError(error: unknown): string {
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
 * Feature 1 baseline: one agent, streamed over SSE.
 *
 * The agent itself is a placeholder that later features replace. What is meant
 * to last is the transport — the event schema, the `id:` sequence, and the
 * guarantee that a failure always reaches the client as `run_failed`.
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
  const agentId = crypto.randomUUID();
  const emit = createRunEmitter(runId);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: RunEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(encodeSSE(event)));
      };

      try {
        send(emit({ type: "run_started", question }));
        send(
          emit({
            type: "agent_started",
            agentId,
            role: "researcher",
            label: "Researcher",
          }),
        );
        // Thinking is summarized rather than omitted, so the UI has something
        // to show during the pause before the first answer token.
        send(emit({ type: "agent_progress", agentId, note: "Thinking…" }));

        const messageStream = getAnthropic().messages.stream({
          model: MODEL,
          max_tokens: 16000,
          thinking: { type: "adaptive", display: "summarized" },
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: question }],
        });

        for await (const event of messageStream) {
          if (request.signal.aborted) {
            messageStream.abort();
            break;
          }
          if (event.type !== "content_block_delta") continue;

          if (event.delta.type === "text_delta") {
            send(
              emit({
                type: "agent_progress",
                agentId,
                delta: event.delta.text,
              }),
            );
          } else if (event.delta.type === "thinking_delta") {
            send(
              emit({
                type: "agent_progress",
                agentId,
                thinking: event.delta.thinking,
              }),
            );
          }
        }

        if (!request.signal.aborted) {
          const message = await messageStream.finalMessage();
          if (message.stop_reason === "refusal") {
            send(
              emit({
                type: "agent_failed",
                agentId,
                error: "The model declined to answer this question.",
              }),
            );
            send(emit({ type: "run_failed", error: "The run was declined." }));
          } else {
            send(emit({ type: "agent_finished", agentId }));
            send(emit({ type: "run_finished" }));
          }
        }
      } catch (error) {
        // A stream that dies silently leaves the UI on a spinner forever, so
        // every failure path has to produce a terminal event first.
        console.error(`[run ${runId}] failed`, error);
        const message = toClientError(error);
        send(emit({ type: "agent_failed", agentId, error: message }));
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
