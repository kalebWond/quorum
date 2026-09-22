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

---

## 8. Sonnet 5 at default effort, not Opus

**Date:** 2026-09-22

Every agent runs `claude-sonnet-5` at the default effort level (`high`), set in
`src/lib/anthropic.ts`.

Opus 5 costs $5/$25 per million input/output tokens against Sonnet 5's $2/$10 —
2.5x for the same work. A Feature 1 run measured about $0.03 on Opus; the same
run is roughly $0.012 on Sonnet. That gap compounds badly once Feature 4 fans
out to one researcher per sub-question and a single run becomes five model
calls instead of one.

Effort was the other candidate lever, but it only moves output and thinking
tokens — it does nothing to input. By Feature 5 the input is dominated by
fetched page content, so dropping to `medium` saves roughly 15% of a run while
putting the critic (Feature 9) and the writer (Feature 5) — the two most
judgment-heavy agents — on a quieter model setting. Not a good trade for the
two features the project is actually selling.

**Tradeoff:** Sonnet may not match Opus on the critic's job of spotting weak
evidence. That is measured at Feature 9, not guessed at now; `effort` is
per-request, so raising just the critic is a one-line change when there is
evidence for it.

---

## 9. Search runs on Anthropic's servers, fetching runs on ours

**Date:** 2026-09-22

The researcher declares Anthropic's server-side `web_search_20260209` tool, but
retrieval is a custom `fetch_page` tool implemented in `src/lib/fetch-page.ts`.

The plan called for a search vendor (Tavily or Brave) behind both tools. Using
the server-side search instead removes a vendor, an API key, and a failure mode
from the demo path, and the search results never needed to be ours.

Fetching is different. Four later features depend on owning it: Feature 4 needs
a per-fetch timeout and a failure that does not kill the run, Feature 5 verifies
every citation against the list of URLs actually read, Feature 6 renders each
source as it resolves, and Feature 10 reports per-step latency. All four want
the moment a fetch starts and ends, which a server-side tool does not expose.

**Tradeoff:** page extraction quality is now ours. If findings come back thin,
`fetch-page.ts` is the first place to look, not the model. The visible seam is
that search cannot be narrated — the timeline shows the query, then a pause,
then a result count, while fetches stream source by source.

---

## 10. The researcher's loop is written by hand

**Date:** 2026-09-22

`runResearcher` in `src/lib/research.ts` drives the tool loop directly rather
than using the SDK's `client.beta.messages.toolRunner`.

The runner does not auto-resume `stop_reason: "pause_turn"`, which a server-side
tool makes likely — it stops the loop and returns a silently truncated answer.
That handling has to be written either way, which removes most of what the
runner would have saved. Writing the loop also keeps the route on the non-beta
`messages.stream` it already used, and leaves the per-agent timeouts and partial
failure Feature 4 requires under our control.

**Tradeoff:** more code to maintain than the runner, including the message
bookkeeping it would have handled.

---

## 11. `fetch_page` validates the URL before requesting it

**Date:** 2026-09-22

`assertFetchable` rejects non-http(s) schemes, local hostnames, and private,
loopback, link-local, and reserved IP ranges. Hostnames are resolved and every
returned address is checked, and the guard runs again on each redirect hop.

The URL is model output shaped by a visitor's question, so without this the
endpoint is a server-side request forgery primitive — most usefully against the
cloud instance metadata address, `169.254.169.254`. Validating only the first
URL would not be enough, since a public host can redirect into a private one.

A test caught the case that made this worth writing down: `new URL()` rewrites
`::ffff:10.0.0.1` as `::ffff:a00:1`, so a dotted-quad check alone lets a private
IPv4 address through in IPv6 clothing.

**Tradeoff:** DNS rebinding between the check and the request is still possible.
Closing that needs the connection pinned to the resolved address, which is more
machinery than a demo of this size warrants.

---

## 12. The plan is a run-level artifact, not the planner's output

**Date:** 2026-09-22

`plan_ready` carries the sub-questions on the run envelope rather than on the
planner's agent envelope, and the reducer stores it as `RunState.plan`.

The plan outlives the agent that produced it. Feature 4 maps one researcher to
each sub-question, and Feature 11 lets the user edit the list before any
research starts — both operate on the run, not on a finished planner card. A
test covers the case that makes this concrete: a planner that fails _after_
emitting its plan leaves the plan intact.

---

## 13. The planner streams, so it validates its own output

**Date:** 2026-09-22

`runPlanner` uses `messages.stream` with `output_config.format` rather than the
simpler non-streaming `messages.parse`, then parses the accumulated text with
the same Zod schema it sent to the API.

The planner runs first in every run, so a silent pause there is the worst place
in the app for one — the same reasoning as decision 6. Streaming lets its
reasoning show while it works. The cost is that `parsed_output` is not handed
to us, so the JSON is parsed at this end.

That parse is not redundant. Structured outputs constrain the model's output,
they do not guarantee a complete response: a body truncated at `max_tokens` is
still cut-off JSON. `parsePlan` is pure and carries the retry path, so the
"malformed output is handled gracefully" half of Feature 3 is covered by unit
tests rather than by hoping.

---

## 14. A streamed answer cannot be retracted by a validator

**Date:** 2026-09-22

The researcher's output contract originally required at least one successfully
fetched source; it now requires only non-empty findings.

Feature 3's varied test questions exposed the flaw. Asked "What year was the
Eiffel Tower completed?", the researcher searched, judged the results
sufficient, and answered correctly without fetching a page. The contract then
threw, and a correct answer the user had already watched stream in became a
failed run.

The general rule: a check that can only run after the output has been streamed
cannot be allowed to fail the run, because there is nothing left to withhold.
The source count is now reported — the agent emits a note, and the summary says
"Answered without reading a source" — rather than enforced.

**Tradeoff:** the app will sometimes answer from search results alone. The
invariant that actually matters is not "a source was read" but "every citation
resolves to a page that was read", and that is Feature 5's job, checked while
the report is still being assembled and can still be changed.
