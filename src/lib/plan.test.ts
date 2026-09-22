import { describe, expect, it } from "vitest";
import { parsePlan } from "./plan";

/**
 * Feature 3's done-when has two halves: sensible sub-questions, and malformed
 * output handled gracefully. The first needs a live model; the second is this
 * file, and it is the half that has to keep working forever.
 */
describe("parsePlan", () => {
  it("accepts a well-formed plan", () => {
    const result = parsePlan(
      JSON.stringify({
        subQuestions: ["What does the law require?", "When does it apply?"],
      }),
    );

    expect(result).toEqual({
      ok: true,
      plan: {
        subQuestions: ["What does the law require?", "When does it apply?"],
      },
    });
  });

  it("accepts the maximum of three sub-questions", () => {
    const subQuestions = ["a?", "b?", "c?"];
    const result = parsePlan(JSON.stringify({ subQuestions }));

    expect(result.ok && result.plan.subQuestions).toHaveLength(3);
  });

  it("recovers JSON wrapped in a code fence", () => {
    const result = parsePlan(
      '```json\n{"subQuestions": ["one?", "two?"]}\n```',
    );

    expect(result.ok && result.plan.subQuestions).toEqual(["one?", "two?"]);
  });

  it("recovers JSON buried in prose", () => {
    const result = parsePlan(
      'Here is the plan:\n{"subQuestions": ["one?", "two?"]}\nHope that helps.',
    );

    expect(result.ok && result.plan.subQuestions).toEqual(["one?", "two?"]);
  });

  it("rejects a single sub-question", () => {
    const result = parsePlan(JSON.stringify({ subQuestions: ["only one?"] }));

    expect(result).toEqual({
      ok: false,
      error: "a plan needs at least 2 sub-questions",
    });
  });

  it("rejects more than three sub-questions", () => {
    // The cap is not cosmetic: each sub-question becomes a researcher, and a
    // wave has to finish inside the 60s request budget.
    const result = parsePlan(
      JSON.stringify({ subQuestions: ["a?", "b?", "c?", "d?"] }),
    );

    expect(result).toEqual({
      ok: false,
      error: "a plan may have at most 3 sub-questions",
    });
  });

  it("rejects output that is not JSON at all", () => {
    expect(parsePlan("I think we should look into three things.")).toEqual({
      ok: false,
      error: "the planner did not return JSON",
    });
  });

  it("rejects JSON truncated mid-object", () => {
    expect(parsePlan('{"subQuestions": ["one?", "tw')).toEqual({
      ok: false,
      error: "the planner did not return JSON",
    });
  });

  it("rejects an empty response", () => {
    expect(parsePlan("   ")).toEqual({
      ok: false,
      error: "the planner returned nothing",
    });
  });

  it("rejects valid JSON of the wrong shape", () => {
    const result = parsePlan(JSON.stringify({ questions: ["one?", "two?"] }));

    expect(result.ok).toBe(false);
  });

  it("rejects an empty sub-question", () => {
    const result = parsePlan(
      JSON.stringify({ subQuestions: ["a real one?", "   "] }),
    );

    expect(result.ok).toBe(false);
  });
});
