import { describe, expect, it } from "vitest";
import {
  BudgetError,
  EMPTY_USAGE,
  estimateCost,
  RunBudget,
  type BudgetLimits,
} from "./budget";

/**
 * Feature 8's done-when: the demo cannot run up an unexpected bill.
 *
 * These are the tests that make that a fact rather than an intention.
 */

const LIMITS: BudgetLimits = { usd: 0.1, calls: 3, ms: 1000 };

/** A controllable clock, so time limits are testable without waiting. */
function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("estimateCost", () => {
  it("prices input and output separately", () => {
    // 1M input at $2 plus 1M output at $10.
    expect(
      estimateCost({ ...EMPTY_USAGE, input: 1_000_000, output: 1_000_000 }),
    ).toBeCloseTo(12, 6);
  });

  it("prices a cache read far below a fresh input token", () => {
    const fresh = estimateCost({ ...EMPTY_USAGE, input: 100_000 });
    const cached = estimateCost({ ...EMPTY_USAGE, cacheRead: 100_000 });

    expect(cached).toBeLessThan(fresh);
    expect(cached * 10).toBeCloseTo(fresh, 6);
  });

  it("costs nothing when nothing was used", () => {
    expect(estimateCost(EMPTY_USAGE)).toBe(0);
  });
});

describe("RunBudget", () => {
  it("allows calls up to the call limit, then stops", () => {
    const budget = new RunBudget(LIMITS, clock().now);

    budget.beginCall();
    budget.beginCall();
    budget.beginCall();

    expect(() => budget.beginCall()).toThrow(BudgetError);
    expect(() => budget.beginCall()).toThrow("3 model calls");
  });

  it("stops before the call that would exceed the cost limit, not after", () => {
    // The distinction that matters: a limit found after the request has
    // already been paid for.
    const budget = new RunBudget(LIMITS, clock().now);

    budget.beginCall();
    budget.record({ ...EMPTY_USAGE, output: 20_000 }); // $0.20, over the $0.10 cap

    expect(() => budget.beginCall()).toThrow("cost limit of $0.10");
    expect(budget.snapshot().calls).toBe(1);
  });

  it("stops once the time limit passes", () => {
    const time = clock();
    const budget = new RunBudget(LIMITS, time.now);

    budget.beginCall();
    time.advance(1000);

    expect(() => budget.beginCall()).toThrow("1s time limit");
  });

  it("reports the time left so an agent can size its own deadline", () => {
    const time = clock();
    const budget = new RunBudget(LIMITS, time.now);

    expect(budget.timeLeftMs()).toBe(1000);
    time.advance(400);
    expect(budget.timeLeftMs()).toBe(600);
  });

  it("never reports negative time left", () => {
    const time = clock();
    const budget = new RunBudget(LIMITS, time.now);

    time.advance(5000);
    expect(budget.timeLeftMs()).toBe(0);
  });

  it("accumulates cost across every agent sharing the run", () => {
    const budget = new RunBudget(LIMITS, clock().now);

    budget.beginCall();
    budget.record({ ...EMPTY_USAGE, output: 1_000 });
    budget.beginCall();
    budget.record({ ...EMPTY_USAGE, output: 1_000 });

    expect(budget.snapshot().usd).toBeCloseTo(0.02, 6);
    expect(budget.snapshot().calls).toBe(2);
  });

  it("lets a run inside every limit proceed", () => {
    const budget = new RunBudget(LIMITS, clock().now);

    expect(() => {
      budget.beginCall();
      budget.record({ ...EMPTY_USAGE, input: 1_000, output: 500 });
    }).not.toThrow();
  });

  it("keeps the shipped defaults under a quarter of a dollar", () => {
    // A public demo's worst case per run, stated explicitly so a future
    // change to the defaults has to be deliberate.
    const { usd, calls, ms } = new RunBudget().limits;

    expect(usd).toBeLessThanOrEqual(0.25);
    expect(calls).toBeLessThanOrEqual(20);
    // Must end itself before Vercel's 60s ceiling kills the stream.
    expect(ms).toBeLessThan(60_000);
  });
});
