import { describe, expect, it } from "vitest";
import { describeReset, RateLimiter, visitorKey } from "./rate-limit";

function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const OPTIONS = { limit: 3, windowMs: 1000 };

describe("RateLimiter", () => {
  it("allows up to the limit and reports what is left", () => {
    const limiter = new RateLimiter(OPTIONS, clock().now);

    expect(limiter.check("a")).toMatchObject({ allowed: true, remaining: 2 });
    expect(limiter.check("a")).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.check("a")).toMatchObject({ allowed: true, remaining: 0 });
  });

  it("refuses once the limit is reached", () => {
    const limiter = new RateLimiter(OPTIONS, clock().now);

    for (let i = 0; i < OPTIONS.limit; i++) limiter.check("a");

    expect(limiter.check("a")).toMatchObject({ allowed: false, remaining: 0 });
  });

  it("keeps visitors independent", () => {
    const limiter = new RateLimiter(OPTIONS, clock().now);

    for (let i = 0; i < OPTIONS.limit; i++) limiter.check("a");

    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(true);
  });

  it("lets a refused visitor back in once the window rolls over", () => {
    const time = clock();
    const limiter = new RateLimiter(OPTIONS, time.now);

    for (let i = 0; i < OPTIONS.limit; i++) limiter.check("a");
    expect(limiter.check("a").allowed).toBe(false);

    time.advance(1000);
    expect(limiter.check("a")).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("counts a refused attempt against the window without extending it", () => {
    // Otherwise hammering the endpoint would push the reset further away
    // forever, and the visitor could never get back in.
    const time = clock();
    const limiter = new RateLimiter(OPTIONS, time.now);

    for (let i = 0; i < OPTIONS.limit; i++) limiter.check("a");
    time.advance(400);
    limiter.check("a");
    limiter.check("a");
    time.advance(600);

    expect(limiter.check("a").allowed).toBe(true);
  });

  it("reports a shrinking reset delay as the window elapses", () => {
    const time = clock();
    const limiter = new RateLimiter(OPTIONS, time.now);

    expect(limiter.check("a").resetInMs).toBe(1000);
    time.advance(300);
    expect(limiter.check("a").resetInMs).toBe(700);
  });
});

describe("visitorKey", () => {
  it("takes the client from a forwarded chain", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.5, 70.41.3.18, 150.172.238.178",
    });

    expect(visitorKey(headers)).toBe("203.0.113.5");
  });

  it("falls back to x-real-ip, then to a constant", () => {
    expect(visitorKey(new Headers({ "x-real-ip": "203.0.113.9" }))).toBe(
      "203.0.113.9",
    );
    expect(visitorKey(new Headers())).toBe("unknown");
  });
});

describe("describeReset", () => {
  it("rounds up into words a person would say", () => {
    expect(describeReset(30_000)).toBe("in a minute");
    expect(describeReset(5 * 60_000)).toBe("in 5 minutes");
    expect(describeReset(45 * 60_000)).toBe("in 45 minutes");
    expect(describeReset(90 * 60_000)).toBe("in 2 hours");
  });
});
