import { describe, expect, it } from "vitest";
import { createRunEmitter, type RunEvent } from "./events";
import { initialRunState, reduceRunEvent, reduceRunEvents } from "./run-stream";

const AGENT_A = "agent-a";
const AGENT_B = "agent-b";

function run(...events: RunEvent[]) {
  return reduceRunEvents(initialRunState, events);
}

const emit = () => createRunEmitter("run-1");

describe("reduceRunEvent", () => {
  it("accumulates streamed text in order", () => {
    const e = emit();
    const state = run(
      e({ type: "run_started", question: "q" }),
      e({
        type: "agent_started",
        agentId: AGENT_A,
        role: "researcher",
        label: "Researcher",
      }),
      e({ type: "agent_progress", agentId: AGENT_A, delta: "Hello " }),
      e({ type: "agent_progress", agentId: AGENT_A, delta: "world" }),
    );

    expect(state.status).toBe("running");
    expect(state.agents[0].text).toBe("Hello world");
  });

  it("keeps thinking, notes, and answer text in separate channels", () => {
    const e = emit();
    const state = run(
      e({ type: "run_started", question: "q" }),
      e({
        type: "agent_started",
        agentId: AGENT_A,
        role: "researcher",
        label: "Researcher",
      }),
      e({ type: "agent_progress", agentId: AGENT_A, note: "Thinking…" }),
      e({ type: "agent_progress", agentId: AGENT_A, thinking: "weighing" }),
      e({ type: "agent_progress", agentId: AGENT_A, delta: "Answer" }),
    );

    const [agent] = state.agents;
    expect(agent.notes).toEqual(["Thinking…"]);
    expect(agent.thinking).toBe("weighing");
    expect(agent.text).toBe("Answer");
  });

  it("ignores a replayed event so text is not duplicated", () => {
    const e = emit();
    const started = e({ type: "run_started", question: "q" });
    const agent = e({
      type: "agent_started",
      agentId: AGENT_A,
      role: "researcher",
      label: "Researcher",
    });
    const delta = e({ type: "agent_progress", agentId: AGENT_A, delta: "hi" });

    const state = run(started, agent, delta, delta, delta);
    expect(state.agents[0].text).toBe("hi");
    expect(state.lastSeq).toBe(delta.seq);
  });

  it("ignores an event that arrives out of order behind lastSeq", () => {
    const e = emit();
    const started = e({ type: "run_started", question: "q" });
    const agent = e({
      type: "agent_started",
      agentId: AGENT_A,
      role: "researcher",
      label: "Researcher",
    });
    const first = e({ type: "agent_progress", agentId: AGENT_A, delta: "a" });
    const second = e({ type: "agent_progress", agentId: AGENT_A, delta: "b" });

    const forward = run(started, agent, first, second);
    const reordered = reduceRunEvent(forward, first);

    expect(reordered).toBe(forward);
    expect(reordered.agents[0].text).toBe("ab");
  });

  it("fails one agent without failing the run", () => {
    // The guarantee Feature 4 depends on: a dead researcher is not a dead run.
    const e = emit();
    const state = run(
      e({ type: "run_started", question: "q" }),
      e({
        type: "agent_started",
        agentId: AGENT_A,
        role: "researcher",
        label: "A",
      }),
      e({
        type: "agent_started",
        agentId: AGENT_B,
        role: "researcher",
        label: "B",
      }),
      e({ type: "agent_failed", agentId: AGENT_A, error: "timeout" }),
      e({ type: "agent_finished", agentId: AGENT_B }),
      e({ type: "run_finished" }),
    );

    expect(state.status).toBe("done");
    expect(state.agents[0]).toMatchObject({
      status: "failed",
      error: "timeout",
    });
    expect(state.agents[1].status).toBe("done");
  });

  it("records a run-level failure with its message", () => {
    const e = emit();
    const state = run(
      e({ type: "run_started", question: "q" }),
      e({ type: "run_failed", error: "API key rejected" }),
    );

    expect(state.status).toBe("failed");
    expect(state.error).toBe("API key rejected");
  });

  it("clears prior agents when a new run starts", () => {
    const first = emit();
    const stale = run(
      first({ type: "run_started", question: "old" }),
      first({
        type: "agent_started",
        agentId: AGENT_A,
        role: "researcher",
        label: "A",
      }),
      first({ type: "run_finished" }),
    );

    const second = createRunEmitter("run-2");
    const fresh = reduceRunEvent(
      stale,
      second({ type: "run_started", question: "new" }),
    );

    expect(fresh.agents).toEqual([]);
    expect(fresh.question).toBe("new");
    expect(fresh.status).toBe("running");
  });
});

describe("the plan", () => {
  it("lands on the run, not on an agent", () => {
    const e = emit();
    const state = run(
      e({ type: "run_started", question: "q" }),
      e({ type: "plan_ready", subQuestions: ["one?", "two?"] }),
    );

    expect(state.plan).toEqual(["one?", "two?"]);
    expect(state.status).toBe("running");
  });

  it("is cleared when a new run starts", () => {
    const first = emit();
    const stale = run(
      first({ type: "run_started", question: "old" }),
      first({ type: "plan_ready", subQuestions: ["one?", "two?"] }),
      first({ type: "run_finished" }),
    );

    const second = createRunEmitter("run-2");
    const fresh = reduceRunEvent(
      stale,
      second({ type: "run_started", question: "new" }),
    );

    expect(fresh.plan).toBeUndefined();
  });

  it("survives a planner that failed after producing a plan", () => {
    const e = emit();
    const state = run(
      e({ type: "run_started", question: "q" }),
      e({
        type: "agent_started",
        agentId: AGENT_A,
        role: "planner",
        label: "Planner",
      }),
      e({ type: "plan_ready", subQuestions: ["one?", "two?"] }),
      e({ type: "agent_failed", agentId: AGENT_A, error: "boom" }),
    );

    expect(state.plan).toEqual(["one?", "two?"]);
    expect(state.agents[0].status).toBe("failed");
    expect(state.status).toBe("running");
  });
});

describe("a run with gaps", () => {
  it("finishes as done while recording what is missing", () => {
    // Feature 4's done-when: one failed researcher still leaves a completed
    // run that says what it could not answer.
    const e = emit();
    const state = run(
      e({ type: "run_started", question: "q" }),
      e({ type: "plan_ready", subQuestions: ["one?", "two?"] }),
      e({
        type: "agent_started",
        agentId: AGENT_A,
        role: "researcher",
        label: "one?",
      }),
      e({
        type: "agent_started",
        agentId: AGENT_B,
        role: "researcher",
        label: "two?",
      }),
      e({ type: "agent_progress", agentId: AGENT_A, delta: "Found it." }),
      e({ type: "agent_finished", agentId: AGENT_A }),
      e({ type: "agent_failed", agentId: AGENT_B, error: "Timed out." }),
      e({ type: "run_incomplete", missing: ["two?"] }),
      e({ type: "run_finished" }),
    );

    expect(state.status).toBe("done");
    expect(state.missing).toEqual(["two?"]);
    expect(state.agents.map((a) => a.status)).toEqual(["done", "failed"]);
    expect(state.agents[0].text).toBe("Found it.");
    expect(state.error).toBeUndefined();
  });

  it("clears the gaps when a new run starts", () => {
    const first = emit();
    const stale = run(
      first({ type: "run_started", question: "old" }),
      first({ type: "run_incomplete", missing: ["two?"] }),
      first({ type: "run_finished" }),
    );

    const second = createRunEmitter("run-2");
    const fresh = reduceRunEvent(
      stale,
      second({ type: "run_started", question: "new" }),
    );

    expect(fresh.missing).toBeUndefined();
  });
});

describe("the source ledger", () => {
  const started = (e: ReturnType<typeof emit>) => [
    e({ type: "run_started", question: "q" }),
    e({
      type: "agent_started",
      agentId: AGENT_A,
      role: "researcher",
      label: "Researcher",
    }),
  ];

  it("replaces a fetching row with its result instead of appending", () => {
    const e = emit();
    const state = run(
      ...started(e),
      e({
        type: "agent_source",
        agentId: AGENT_A,
        url: "https://example.com/a",
        status: "fetching",
      }),
      e({
        type: "agent_source",
        agentId: AGENT_A,
        url: "https://example.com/a",
        status: "ok",
        title: "A",
        ms: 1200,
        bytes: 8192,
      }),
    );

    expect(state.agents[0].sources).toEqual([
      {
        url: "https://example.com/a",
        status: "ok",
        title: "A",
        ms: 1200,
        bytes: 8192,
        error: undefined,
      },
    ]);
  });

  it("keeps successful and failed sources side by side, in first-seen order", () => {
    const e = emit();
    const state = run(
      ...started(e),
      e({
        type: "agent_source",
        agentId: AGENT_A,
        url: "https://a.example/1",
        status: "fetching",
      }),
      e({
        type: "agent_source",
        agentId: AGENT_A,
        url: "https://b.example/2",
        status: "fetching",
      }),
      // Resolves out of order — the list must not reorder itself.
      e({
        type: "agent_source",
        agentId: AGENT_A,
        url: "https://b.example/2",
        status: "failed",
        error: "timed out after 10s",
      }),
      e({
        type: "agent_source",
        agentId: AGENT_A,
        url: "https://a.example/1",
        status: "ok",
        ms: 900,
      }),
    );

    const { sources } = state.agents[0];
    expect(sources.map((s) => s.url)).toEqual([
      "https://a.example/1",
      "https://b.example/2",
    ]);
    expect(sources.map((s) => s.status)).toEqual(["ok", "failed"]);
    expect(sources[1].error).toBe("timed out after 10s");
  });

  it("does not leak sources between agents", () => {
    const e = emit();
    const state = run(
      ...started(e),
      e({
        type: "agent_started",
        agentId: AGENT_B,
        role: "researcher",
        label: "Researcher 2",
      }),
      e({
        type: "agent_source",
        agentId: AGENT_A,
        url: "https://example.com/a",
        status: "ok",
      }),
    );

    expect(state.agents[0].sources).toHaveLength(1);
    expect(state.agents[1].sources).toEqual([]);
  });

  it("starts every agent with an empty ledger", () => {
    const e = emit();
    const state = run(...started(e));
    expect(state.agents[0].sources).toEqual([]);
  });
});
