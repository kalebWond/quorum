import { describe, expect, it } from "vitest";
import { mapWithLimit } from "./concurrency";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("mapWithLimit", () => {
  it("returns results in input order, not completion order", async () => {
    const results = await mapWithLimit([30, 10, 20], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });

    expect(results.map((r) => r.status === "fulfilled" && r.value)).toEqual([
      30, 10, 20,
    ]);
  });

  it("never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithLimit([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
    });

    expect(peak).toBe(3);
  });

  it("lets the other tasks finish when one throws", async () => {
    // Feature 4's done-when: one deliberately failing researcher must not
    // take the run down with it.
    const results = await mapWithLimit(["a", "boom", "c"], 2, async (item) => {
      await tick();
      if (item === "boom") throw new Error("researcher died");
      return item.toUpperCase();
    });

    expect(results.map((r) => r.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    expect(results[0].status === "fulfilled" && results[0].value).toBe("A");
    expect(results[2].status === "fulfilled" && results[2].value).toBe("C");
    expect(
      results[1].status === "rejected" && (results[1].reason as Error).message,
    ).toBe("researcher died");
  });

  it("keeps going when every task fails", async () => {
    const results = await mapWithLimit([1, 2], 2, async () => {
      throw new Error("all dead");
    });

    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  });

  it("handles an empty list without starting a worker", async () => {
    let started = 0;
    const results = await mapWithLimit([], 3, async () => {
      started++;
      return 1;
    });

    expect(results).toEqual([]);
    expect(started).toBe(0);
  });

  it("does not start more workers than there are items", async () => {
    let peak = 0;
    let inFlight = 0;

    await mapWithLimit([1, 2], 10, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
    });

    expect(peak).toBe(2);
  });

  it("rejects a limit below one", async () => {
    await expect(mapWithLimit([1], 0, async (n) => n)).rejects.toThrow(
      RangeError,
    );
  });
});
