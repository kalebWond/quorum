import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runEventSchema, type RunEvent } from "./events";
import { initialRunState, reduceRunEvents } from "./run-stream";

/**
 * The sample run is replayed in the browser through the same reducer as a live
 * run, so it has to satisfy the same schema. Without this test the fixture
 * would rot silently the first time an event gains a field.
 */

const fixture = JSON.parse(
  readFileSync("public/fixtures/sample-run.json", "utf8"),
) as { question: string; events: unknown[] };

describe("the sample run fixture", () => {
  it("contains only valid run events", () => {
    const invalid = fixture.events
      .map((event, index) => ({
        index,
        result: runEventSchema.safeParse(event),
      }))
      .filter((entry) => !entry.result.success);

    expect(invalid.map((e) => e.index)).toEqual([]);
  });

  it("carries a gap-free ascending seq, so replay dedup behaves", () => {
    const events = fixture.events as RunEvent[];
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  });

  it("has non-decreasing timestamps, so replay never schedules backwards", () => {
    const events = fixture.events as RunEvent[];
    for (let i = 1; i < events.length; i++) {
      expect(events[i].ts).toBeGreaterThanOrEqual(events[i - 1].ts);
    }
  });

  it("reduces to a finished run with every agent resolved", () => {
    const state = reduceRunEvents(
      initialRunState,
      fixture.events as RunEvent[],
    );

    expect(state.status).toBe("done");
    expect(state.question).toBe(fixture.question);
    expect(state.plan).toHaveLength(3);
    expect(state.agents).toHaveLength(5);
    expect(state.agents.every((a) => a.status !== "working")).toBe(true);
  });

  it("exercises the parts of the timeline worth demonstrating", () => {
    const state = reduceRunEvents(
      initialRunState,
      fixture.events as RunEvent[],
    );

    // Every role appears, so the timeline shows the full shape.
    expect(new Set(state.agents.map((a) => a.role))).toEqual(
      new Set(["planner", "researcher", "writer"]),
    );
    // A failed fetch alongside successful ones, so both states render.
    const allSources = state.agents.flatMap((a) => a.sources);
    expect(allSources.some((s) => s.status === "failed")).toBe(true);
    expect(allSources.some((s) => s.status === "ok")).toBe(true);
    // A stripped citation, so the verifier's work is visible in the sample.
    expect(state.report?.rejected).toHaveLength(1);
  });

  it("keeps the rejected citation out of the verified report", () => {
    const state = reduceRunEvents(
      initialRunState,
      fixture.events as RunEvent[],
    );

    const writer = state.agents.find((a) => a.role === "writer");
    expect(writer?.text).toContain("ai-readiness-institute.example");
    expect(state.report?.markdown).not.toContain("ai-readiness-institute");
  });
});
