/**
 * Per-run limits: Feature 8.
 *
 * Feature 8's done-when is that the demo cannot run up an unexpected bill, so
 * the budget is denominated in dollars rather than tokens. A token ceiling
 * would have to be re-derived every time the model or the prompt shape
 * changes; a dollar ceiling means what it says.
 *
 * Written after a development session spent ~$4.50 on runs that returned
 * nothing (DECISIONS 15). Limits are checked *before* a call, because a limit
 * discovered afterwards has already been paid for.
 */

/** A limit was reached. Safe to show a visitor. */
export class BudgetError extends Error {}

export type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export const EMPTY_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * USD per million tokens for the model in `anthropic.ts`.
 *
 * Cache reads bill at roughly a tenth of input and writes at roughly 1.25x,
 * which is why caching is the lever it is.
 */
export const PRICING = {
  input: 2.0,
  output: 10.0,
  cacheRead: 0.2,
  cacheWrite: 2.5,
} as const;

/** Estimated cost of one call, in USD. */
export function estimateCost(usage: TokenUsage): number {
  return (
    (usage.input * PRICING.input +
      usage.output * PRICING.output +
      usage.cacheRead * PRICING.cacheRead +
      usage.cacheWrite * PRICING.cacheWrite) /
    1_000_000
  );
}

export type BudgetLimits = {
  /** Hard ceiling on estimated spend for one run, in USD. */
  usd: number;
  /** Hard ceiling on model calls, so a loop cannot spin cheaply but forever. */
  calls: number;
  /** Wall-clock ceiling for the whole run. */
  ms: number;
};

/**
 * What a public run is allowed to consume.
 *
 * `ms` sits under Vercel's 60s ceiling so the run ends itself with a clear
 * message rather than being killed mid-stream, which would leave the UI on a
 * spinner. `calls` allows a planner, three researchers with a few turns each,
 * and a writer, with room for one retry.
 */
export const DEFAULT_LIMITS: BudgetLimits = {
  usd: 0.25,
  calls: 20,
  ms: 55_000,
};

export type BudgetSnapshot = {
  usd: number;
  calls: number;
  elapsedMs: number;
  limits: BudgetLimits;
};

/**
 * Tracks one run against its limits.
 *
 * Deliberately a small mutable object rather than something clever: every
 * agent in a run shares one instance, and the ordering guarantee that matters
 * is simply that `beginCall` runs before the request and `record` after it.
 */
export class RunBudget {
  private usd = 0;
  private calls = 0;
  private readonly startedAt: number;

  constructor(
    readonly limits: BudgetLimits = DEFAULT_LIMITS,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  get elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  /** Milliseconds left before the run must stop. Never negative. */
  timeLeftMs(): number {
    return Math.max(0, this.limits.ms - this.elapsedMs);
  }

  /**
   * Claims one model call, or throws.
   *
   * Called before the request goes out, so a run that is already over budget
   * spends nothing more.
   */
  beginCall(): void {
    if (this.elapsedMs >= this.limits.ms) {
      throw new BudgetError(
        `This run hit its ${Math.round(this.limits.ms / 1000)}s time limit.`,
      );
    }
    if (this.calls >= this.limits.calls) {
      throw new BudgetError(
        `This run hit its limit of ${this.limits.calls} model calls.`,
      );
    }
    if (this.usd >= this.limits.usd) {
      throw new BudgetError(
        `This run hit its cost limit of $${this.limits.usd.toFixed(2)}.`,
      );
    }
    this.calls++;
  }

  /** Records what a completed call actually cost. */
  record(usage: TokenUsage): void {
    this.usd += estimateCost(usage);
  }

  snapshot(): BudgetSnapshot {
    return {
      usd: this.usd,
      calls: this.calls,
      elapsedMs: this.elapsedMs,
      limits: this.limits,
    };
  }
}
