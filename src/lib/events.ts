import { z } from "zod";

/**
 * The event schema every agent in every feature emits.
 *
 * This is the contract between the orchestrator and the UI. Feature 1 has a
 * single agent, but the shape is designed for the full planner → researchers →
 * critic → writer run, so later features add emitters rather than change this
 * file. See DECISIONS.md for why `seq` and `agent_failed` exist this early.
 */

export const agentRoleSchema = z.enum([
  "planner",
  "researcher",
  "critic",
  "writer",
]);
export type AgentRole = z.infer<typeof agentRoleSchema>;

const envelope = {
  runId: z.string().min(1),
  /** Monotonic per run. Doubles as the SSE `id:`, which drives reconnects. */
  seq: z.number().int().nonnegative(),
  ts: z.number().int(),
};

const agentEnvelope = { ...envelope, agentId: z.string().min(1) };

export const runEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...envelope,
    type: z.literal("run_started"),
    question: z.string(),
  }),
  z.object({
    ...envelope,
    /**
     * The planner's sub-questions.
     *
     * Run-level rather than agent-scoped: the plan outlives the planner. In
     * Feature 4 it becomes one researcher per entry, and in Feature 11 the
     * user edits it before any research starts.
     */
    type: z.literal("plan_ready"),
    subQuestions: z.array(z.string()).min(1),
  }),
  z.object({
    ...agentEnvelope,
    type: z.literal("agent_started"),
    role: agentRoleSchema,
    label: z.string(),
  }),
  z.object({
    ...agentEnvelope,
    type: z.literal("agent_progress"),
    /** Answer text to append verbatim. */
    delta: z.string().optional(),
    /** Summarized reasoning, rendered separately from the answer. */
    thinking: z.string().optional(),
    /** A discrete status line, e.g. "fetched 3 sources". */
    note: z.string().optional(),
  }),
  z.object({
    ...agentEnvelope,
    /**
     * One source the agent tried to read. Emitted twice per URL — once as
     * `fetching`, once as `ok` or `failed`.
     *
     * Structured rather than folded into a `note` because Feature 5 verifies
     * every citation against this ledger, and Feature 6 renders it as cards.
     */
    type: z.literal("agent_source"),
    url: z.string().url(),
    status: z.enum(["fetching", "ok", "failed"]),
    title: z.string().optional(),
    ms: z.number().int().nonnegative().optional(),
    bytes: z.number().int().nonnegative().optional(),
    error: z.string().optional(),
  }),
  z.object({
    ...agentEnvelope,
    type: z.literal("agent_finished"),
    summary: z.string().optional(),
  }),
  z.object({
    ...agentEnvelope,
    type: z.literal("agent_failed"),
    error: z.string(),
  }),
  z.object({ ...envelope, type: z.literal("run_finished") }),
  z.object({ ...envelope, type: z.literal("run_failed"), error: z.string() }),
]);

export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventType = RunEvent["type"];

/**
 * A run event minus the envelope fields the emitter fills in.
 *
 * Distributes over the union rather than omitting from it, so each variant
 * keeps its own fields and the discriminated check still applies at call sites.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type RunEventBody = DistributiveOmit<RunEvent, "runId" | "seq" | "ts">;

/**
 * Emits one event upstream.
 *
 * Every agent takes one of these. The caller stamps the envelope and writes the
 * SSE frame, so an agent never knows how it is being transported.
 */
export type EmitFn = (body: RunEventBody) => void;

/**
 * Stamps `runId`, `seq`, and `ts` onto each event so call sites never track
 * sequence numbers by hand — the single place `seq` increments.
 */
export function createRunEmitter(runId: string, startSeq = 0) {
  let seq = startSeq;
  return function emit(body: RunEventBody): RunEvent {
    return {
      ...body,
      runId,
      seq: seq++,
      ts: Date.now(),
    } as RunEvent;
  };
}

/** Formats one event as an SSE frame. The `id:` line is what enables resume. */
export function encodeSSE(event: RunEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Parses the `data:` payload of one SSE frame.
 *
 * Returns null rather than throwing: a malformed frame should drop that event,
 * not tear down a run that is otherwise fine.
 */
export function parseRunEvent(data: string): RunEvent | null {
  try {
    const result = runEventSchema.safeParse(JSON.parse(data));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Splits a read buffer into complete SSE frames, returning the trailing
 * partial frame as `rest`.
 *
 * Chunk boundaries fall wherever the network puts them, so a frame routinely
 * arrives split across two reads. Callers carry `rest` into the next read.
 */
export function splitSSEFrames(buffer: string): {
  frames: string[];
  rest: string;
} {
  const parts = buffer.split("\n\n");
  return { frames: parts.slice(0, -1), rest: parts[parts.length - 1] ?? "" };
}

/** Extracts and validates the event carried by one complete SSE frame. */
export function readSSEFrame(frame: string): RunEvent | null {
  const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
  return dataLine ? parseRunEvent(dataLine.slice(5).trim()) : null;
}
