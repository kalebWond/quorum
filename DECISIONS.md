# Decisions

Architecture choices and the reasoning behind them, written as they are made.
This is the source material for the Feature 12 case study — the _why_ is the
part that is hard to reconstruct later.

---

## 1. The project is called Quorum

**Date:** 2026-09-22

A quorum is the group that must convene before a decision counts, which is
exactly the architecture: a planner, parallel researchers, a critic, and a
writer that together produce one answer. Short enough for a URL and memorable
in a portfolio, where `research-assistant` would be neither.

---

## 2. Postgres is deferred from Feature 0 to Feature 7

**Date:** 2026-09-22

The original plan provisioned Postgres during project setup, but nothing reads
or writes it until Feature 7.

A connection with no schema, no reads, and no writes cannot be meaningfully
verified — "it connected once" is not a passing test. Deferring also means the
schema gets designed once the real shape of runs, agent steps, and reports is
known, rather than guessed at at the start and migrated later.

**Tradeoff:** Feature 7 is bigger, since it now includes provisioning and
connection setup alongside the schema work.

---

## 3. The event schema carries `seq` from day one

**Date:** 2026-09-22

Every event in `src/lib/events.ts` has a monotonic `seq`, which is also written
as the SSE `id:` on each frame.

Feature 7 requires reconnecting to an in-progress run after a page refresh.
SSE's native mechanism for that is the `Last-Event-ID` header, which only works
if frames carried ids all along. Adding the field now is free; adding it after
runs are persisted means migrating stored events.

The client reducer drops any event whose `seq` it has already applied, because
`delta` accumulates — replaying one would duplicate text in the answer. That
guard is scoped to the current `runId`, since `seq` restarts at 0 for each run
and a new run's opening events must not look like replays of the last one.

---

## 4. `agent_failed` is separate from `run_failed`

**Date:** 2026-09-22

Feature 4 requires that a single failing researcher not kill the whole run —
the run continues and reports what is missing. The schema has to be able to
express "this agent died, the run did not" before Feature 4 needs it, so both
events exist now and the reducer already treats them differently.

---

## 5. Three progress channels, not one

**Date:** 2026-09-22

`agent_progress` carries `delta` (answer text to append), `thinking`
(summarized reasoning), and `note` (a discrete status line such as
"fetched 3 sources").

Collapsing these into a single text field would make the Feature 6 timeline
cards ambiguous — there would be no way to render reasoning differently from
the answer, or to show the latest status without it being swallowed by the
prose.

---

## 6. Thinking is summarized rather than omitted

**Date:** 2026-09-22

Claude Opus 5 defaults to `display: "omitted"`, which streams empty thinking
blocks. On a research question that means a long silent pause before the first
answer token — indistinguishable from a hung request.

`display: "summarized"` gives the UI something truthful to show during that
window. A `note` event is also emitted before the model call for the same
reason.

---

## 7. Stream state is reduced by a pure function

**Date:** 2026-09-22

`reduceRunEvent` in `src/lib/run-stream.ts` holds all state shaping; the
`useRunStream` hook owns only the transport.

It makes the interesting logic — accumulation, deduplication, per-agent status
— testable without a DOM or a live API call, which keeps Vitest on the `node`
environment with no jsdom dependency. Feature 6 builds its timeline on the same
reducer rather than re-reading the stream.
