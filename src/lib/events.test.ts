import { describe, expect, it } from "vitest";
import {
  createRunEmitter,
  encodeSSE,
  parseRunEvent,
  readSSEFrame,
  runEventSchema,
  splitSSEFrames,
  type RunEvent,
} from "./events";

const RUN_ID = "run-1";
const AGENT_ID = "agent-1";

function sample(): RunEvent[] {
  const emit = createRunEmitter(RUN_ID);
  return [
    emit({ type: "run_started", question: "Why is the sky blue?" }),
    emit({ type: "plan_ready", subQuestions: ["one?", "two?"] }),
    emit({
      type: "agent_started",
      agentId: AGENT_ID,
      role: "researcher",
      label: "Researcher",
    }),
    emit({ type: "agent_progress", agentId: AGENT_ID, delta: "Because " }),
    emit({ type: "agent_progress", agentId: AGENT_ID, thinking: "hmm" }),
    emit({ type: "agent_progress", agentId: AGENT_ID, note: "Thinking…" }),
    emit({
      type: "agent_source",
      agentId: AGENT_ID,
      url: "https://example.com/a",
      status: "fetching",
    }),
    emit({
      type: "agent_source",
      agentId: AGENT_ID,
      url: "https://example.com/a",
      status: "ok",
      title: "A",
      ms: 1200,
      bytes: 8192,
    }),
    emit({ type: "agent_finished", agentId: AGENT_ID, summary: "done" }),
    emit({ type: "agent_failed", agentId: AGENT_ID, error: "boom" }),
    emit({ type: "run_incomplete", missing: ["two?"] }),
    emit({ type: "run_finished" }),
    emit({ type: "run_failed", error: "boom" }),
  ];
}

describe("runEventSchema", () => {
  it("accepts every event variant", () => {
    for (const event of sample()) {
      expect(runEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("rejects an unknown event type", () => {
    const result = runEventSchema.safeParse({
      type: "agent_exploded",
      runId: RUN_ID,
      seq: 0,
      ts: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects an event missing a required field", () => {
    // agent_failed without `error` — the field the UI needs to explain itself.
    const result = runEventSchema.safeParse({
      type: "agent_failed",
      runId: RUN_ID,
      agentId: AGENT_ID,
      seq: 0,
      ts: Date.now(),
    });
    expect(result.success).toBe(false);
  });
});

describe("createRunEmitter", () => {
  it("assigns a gap-free ascending seq", () => {
    const events = sample();
    expect(events.map((event) => event.seq)).toEqual(
      events.map((_, index) => index),
    );
  });

  it("stamps the same runId on every event", () => {
    expect(sample().every((event) => event.runId === RUN_ID)).toBe(true);
  });
});

describe("SSE encoding", () => {
  it("round-trips every variant through encode and parse", () => {
    for (const event of sample()) {
      expect(readSSEFrame(encodeSSE(event).trimEnd())).toEqual(event);
    }
  });

  it("writes seq as the frame id so a client can resume", () => {
    const [first] = sample();
    expect(encodeSSE(first).startsWith(`id: ${first.seq}\n`)).toBe(true);
  });

  it("returns null for malformed JSON rather than throwing", () => {
    expect(parseRunEvent("{not json")).toBeNull();
  });

  it("returns null for well-formed JSON that fails the schema", () => {
    expect(parseRunEvent(JSON.stringify({ type: "nope" }))).toBeNull();
  });
});

describe("splitSSEFrames", () => {
  it("separates complete frames from a trailing partial one", () => {
    const { frames, rest } = splitSSEFrames("a\n\nb\n\nc-part");
    expect(frames).toEqual(["a", "b"]);
    expect(rest).toBe("c-part");
  });

  it("holds back a frame split across two reads", () => {
    const events = sample().slice(0, 2);
    const wire = events.map(encodeSSE).join("");
    const cut = wire.indexOf("\n\n") + 1; // mid-terminator, worst case

    const first = splitSSEFrames(wire.slice(0, cut));
    expect(first.frames).toHaveLength(0);

    const second = splitSSEFrames(first.rest + wire.slice(cut));
    expect(second.frames.map(readSSEFrame)).toEqual(events);
  });
});
