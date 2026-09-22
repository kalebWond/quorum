/**
 * Runs tasks over a list with a ceiling on how many are in flight.
 *
 * Kept separate from the agents so the fan-out's awkward parts — a failing
 * task not taking its neighbours down, results staying aligned with their
 * inputs — are testable without a model call.
 */

/**
 * Maps `items` through `task`, at most `limit` at a time.
 *
 * Every task is settled, never thrown: one failure must not cancel the others,
 * which is the whole point of Feature 4. Results are returned in the order of
 * `items`, not completion order, so a caller can always pair `results[i]` with
 * `items[i]`.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (limit < 1) throw new RangeError("limit must be at least 1");

  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;

      try {
        results[index] = {
          status: "fulfilled",
          value: await task(items[index], index),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  // One worker per slot, each pulling the next index until the list runs out.
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );

  return results;
}
