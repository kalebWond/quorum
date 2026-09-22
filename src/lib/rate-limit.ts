/**
 * Per-visitor rate limiting: Feature 8.
 *
 * A fixed window counted in memory. That choice has a real limitation and it
 * is better stated than discovered: serverless runs several instances, each
 * with its own map, so a determined visitor gets roughly (limit x instances).
 * It stops casual repeat-clicking and accidental loops, which is most of the
 * risk for a portfolio demo, and it is not a defence against someone trying.
 *
 * The per-run budget in `budget.ts` is the ceiling that does not leak — it
 * bounds what any single run can spend regardless of how many get through.
 * Feature 7 brings a shared datastore, at which point this moves there and
 * becomes exact.
 */

export type RateLimitResult =
  | { allowed: true; remaining: number; resetInMs: number }
  | { allowed: false; remaining: 0; resetInMs: number };

export type RateLimitOptions = {
  /** Requests permitted per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

/** A public demo's allowance: enough to try it properly, not enough to mine it. */
export const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  limit: 5,
  windowMs: 60 * 60 * 1000,
};

type Window = { count: number; startedAt: number };

/**
 * Fixed-window counter keyed by visitor.
 *
 * Exported as a class so tests get an isolated instance with their own clock;
 * the route uses the shared `rateLimiter` below.
 */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly options: RateLimitOptions = DEFAULT_RATE_LIMIT,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): RateLimitResult {
    const at = this.now();
    const existing = this.windows.get(key);
    const window =
      existing && at - existing.startedAt < this.options.windowMs
        ? existing
        : { count: 0, startedAt: at };

    const resetInMs = window.startedAt + this.options.windowMs - at;

    if (window.count >= this.options.limit) {
      this.windows.set(key, window);
      return { allowed: false, remaining: 0, resetInMs };
    }

    window.count++;
    this.windows.set(key, window);

    // Opportunistic sweep: without it the map grows for the life of the
    // instance, since nothing else ever removes a key.
    if (this.windows.size > 1000) this.sweep(at);

    return {
      allowed: true,
      remaining: this.options.limit - window.count,
      resetInMs,
    };
  }

  private sweep(at: number): void {
    for (const [key, window] of this.windows) {
      if (at - window.startedAt >= this.options.windowMs) {
        this.windows.delete(key);
      }
    }
  }
}

/**
 * Identifies a visitor from request headers.
 *
 * `x-forwarded-for` can be a list; the client is the first entry. It is
 * trivially spoofable, which is another reason the per-run budget rather than
 * this is the real ceiling.
 */
export function visitorKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return headers.get("x-real-ip") ?? "unknown";
}

/** Shared across requests on one instance. */
export const rateLimiter = new RateLimiter();

/** Turns a reset delay into something worth reading. */
export function describeReset(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return "in a minute";
  if (minutes < 60) return `in ${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "in an hour" : `in ${hours} hours`;
}
