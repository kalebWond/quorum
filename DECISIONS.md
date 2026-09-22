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

---

## 15. Cost is a property of the loop, not of the model

**Date:** 2026-09-22

A development session spent roughly $4.50, most of it on parallel runs that
timed out and returned nothing. The post-mortem changed where cost is managed.

The model choice in decision 8 was the wrong thing to optimise first. The
dominant cost is that the Messages API is stateless: every turn of the
researcher's loop re-sends the entire conversation, and by the last turn that
conversation contains several fetched pages. A five-turn researcher reading
three pages bills roughly 58k input tokens for about 24k tokens of actual
content, because the middle of the conversation is paid for four times.

Four changes, in order of effect:

1. **Prompt caching** (`cache_control: { type: "ephemeral" }`) on the
   researcher's request. `tools`, `system`, and `messages` are all append-only
   here, so the prefix is stable and each turn reads what the previous one
   wrote at roughly a tenth of the price.
2. **`MAX_TURNS` 8 -> 5.** The intended shape is search, read, read, read,
   answer. A higher ceiling does not buy thoroughness, it permits flailing at
   the most expensive point in the loop.
3. **Page text capped at 12k characters**, down from 24k. Fetched text is
   re-sent every turn, and the answer to a focused sub-question is usually near
   the top of the page.
4. **Per-researcher token logging**, so the next live run shows whether the
   cache is actually being hit rather than requiring a second run to find out.

Context editing (`clear_tool_uses_20250919`) was considered and rejected: it
drops old tool results from the history, which would invalidate the cached
prefix on every turn and fight change 1 rather than compound with it.

**Tradeoff:** a smaller page cap and fewer turns mean a researcher can miss
evidence that sits deep in a long document. That is a quality risk to measure
once there are credits to measure it with.

---

## 16. Diagnose with the cheapest thing that can answer the question

**Date:** 2026-09-22

Four full live runs were spent diagnosing what turned out to be an exhausted
credit balance. A 20-line script hitting the API directly found it in 0.7
seconds for nothing.

Two things made the expensive path look necessary. `runResearchers` mapped
every unexpected error to `"This researcher failed."` and logged nothing, so a
400 was indistinguishable from a slow agent. And piped `curl` output is
buffered, so the timestamps suggested three agents running in parallel when
they were running one at a time — which sent the investigation after a
concurrency bug that did not exist.

Both are fixed: unexpected failures are logged server-side with the real error,
and `scripts/trace-run.mjs` reads the `ts` on each frame instead of trusting
wall-clock at the reader.

**The rule:** before repeating a run that costs money, state what changed and
what result would distinguish the hypotheses. If a unit test or a direct probe
can answer it, the live run is not the diagnostic — it is the confirmation.

---

## 17. The report the user keeps is not the draft they watched arrive

**Date:** 2026-09-22

The writer's draft streams as `delta`, so the report is visibly written. But
the draft is not the artifact: `report_ready` carries the citation-verified
copy, and the UI renders that in place of the streamed text once it lands.

Verification cannot happen mid-stream. Whether a citation resolves is only
answerable once the sentence containing it is complete, and stripping text the
user has already read is worse than replacing the whole block at once.

Decision 14 established that a streamed answer cannot be retracted by a
validator. This is the shape that respects it: the draft is framed as a draft,
the verified report is a separate artifact, and the swap happens at a natural
boundary rather than mid-sentence. Showing "3 unverifiable citations removed"
above the report turns the check into something a visitor can see working,
which is the point of the feature.

---

## 18. Citations are verified by construction, not by prompting

**Date:** 2026-09-22

`src/lib/citations.ts` takes the writer's draft and the union of every
researcher's fetched-URL ledger, and removes any citation that does not
resolve: a `[n]` past the end of the source list, a markdown link to a URL
nobody fetched, and a bare URL nobody fetched. The prose survives; only the
unearned citation goes.

The system prompt also asks for honest citations, but a prompt is a request.
The guarantee the project actually advertises — every citation maps to a page
a researcher read — has to be a property of the code, and it is: the module is
pure, and 17 tests cover it, including a deliberately invented URL. A mutation
that trusted the writer's URLs instead of the ledger was checked to fail three
of them.

Two details that turned out to matter. URLs are normalised before comparison
(fragment, trailing slash, `www.`, host case) because a writer echoing a
source varies all four, and treating those as different pages would strip
legitimate citations. Path case is deliberately preserved, since it can be
significant.

**Tradeoff:** the verifier checks that a citation _resolves_, not that the
source _supports the claim_. Attribution to the wrong fetched page is not
detectable here — that is the critic's job in Feature 9.

---

## 19. The sample run replays through the same reducer as a live run

**Date:** 2026-09-22

`public/fixtures/sample-run.json` is a recorded run, and `useRunStream.replay`
plays it back at its original pace through `reduceRunEvent` — the same function
a live run uses.

Two things fall out of that. The timeline could be built and reviewed with no
API credits at all, which is how Feature 6 got done during a billing outage.
And the sample cannot drift from reality: it is not a mock of the UI, it is the
UI driven by the same events the server emits. `fixture.test.ts` validates every
event in the file against `runEventSchema`, so the fixture breaks loudly if the
schema moves rather than rotting quietly.

This is also the mechanism Feature 8 needs for "pre-generated sample reports
anyone can browse without triggering new API calls" — that feature is now
mostly a matter of recording more fixtures.

**Provenance, stated plainly:** the sample's URLs, titles, fetch timings and
failure reasons are from a real run on 2026-09-22. The multi-agent shape around
them is assembled in `scripts/make-fixture.mjs`, because no full end-to-end run
has been recorded yet. It is a demonstration of the interface, not evidence of
a result. When a real run can be recorded, the assembly should be replaced with
a straight conversion of that capture.

---

## 20. Status is shown by shape, not by a legend

**Date:** 2026-09-22

Each agent card carries its role, a coloured status dot, and — while working —
its own latest note, such as the search query it is running. The detail is
behind a disclosure: sources with per-fetch timings, reasoning, findings.

Feature 6's done-when is that a visitor understands the run without
explanation, which rules out a legend or a tooltip glossary. A pulsing blue dot
next to a live search query reads as "this one is working on that right now"
with no key to consult; three of them stacked reads as parallelism. Putting the
per-source detail behind a click keeps the run scannable at a glance while
still answering "what did it actually read" for anyone who wants it.

The verified report renders through `react-markdown` rather than a hand-rolled
parser. The content is model output, so the renderer has to be safe by
construction; react-markdown builds React elements and never touches
`dangerouslySetInnerHTML`.

---

## 21. The run budget is denominated in dollars

**Date:** 2026-09-22

`RunBudget` caps one run at $0.25, 20 model calls, and 55 seconds. Every agent
in a run shares one instance, claims a call with `beginCall()` before the
request, and reports what it cost with `record()` after.

Dollars rather than tokens because Feature 8's done-when is about a bill. A
token ceiling has to be re-derived whenever the model, the prompt shape, or the
caching strategy changes; a dollar ceiling keeps meaning the same thing. The
prices live in one table next to the estimator.

The ordering is the part that matters. A limit checked _after_ a call has
already been paid for, which is exactly how the ~$4.50 session went: runs that
returned nothing still billed for everything they generated before being
aborted. `beginCall()` refuses first and spends nothing.

Two deliberate details. The 55s ceiling sits under Vercel's 60s so a run ends
itself with a readable message instead of being killed mid-stream. And a
researcher that cannot afford another turn stops with what it has rather than
failing — a partial answer beats no answer, which is the same reasoning as
decision 14.

---

## 22. The rate limiter leaks, and the budget is why that is acceptable

**Date:** 2026-09-22

Per-visitor limiting is a fixed window counted in memory: 5 runs per hour,
keyed on the forwarded client IP.

It genuinely leaks. Serverless runs several instances, each with its own map,
so a determined visitor gets roughly (limit x instances) — and `x-forwarded-for`
is spoofable anyway. A hot reload during development demonstrated the same
weakness by resetting the counter mid-test.

It is still worth having, because it stops the realistic failure for a
portfolio demo: someone clicking repeatedly, or a loop hitting the endpoint by
accident. What it is not is a defence against someone trying, and the honest
mitigation is that it does not need to be one — the per-run budget bounds what
any single run can spend no matter how many get through. One leaky limit
multiplied by a hard ceiling is still a bounded bill.

Feature 7 brings a shared datastore, at which point this moves there and
becomes exact.

---

## 23. A provider 400 is this deployment's problem, not the visitor's

**Date:** 2026-09-22

`Anthropic.BadRequestError` now maps to "Quorum cannot run new research right
now. Use 'Watch a sample run' to see a finished run in full."

An exhausted credit balance arrives as a 400, and the previous message — "The
model request failed (400)" — was what every visitor to the public demo saw
while the balance was empty. It is accurate, tells them nothing they can act
on, and leaves a page whose description promises a working system.

Pairing the message with the sample run is what makes the difference: the demo
degrades to something that still shows the whole system working, rather than to
an error. That is the other half of Feature 8's done-when — a visitor with no
quota left still has something to explore — and it applies just as well when
the quota that ran out is the operator's.
