# Quorum — Multi-Agent Research Assistant

A feature-by-feature build plan.

## Context (paste this into a new chat to get started)

I'm a senior full-stack engineer (TypeScript, React/Next.js, Node.js, PostgreSQL, AWS-certified) building a portfolio project for my Upwork profile and personal site. I already have a production AI project (a trucking/logistics platform using the Claude API for document parsing, route suggestions, and scheduling-conflict detection). This project shows a different skill: **multi-agent orchestration with a live, visible agent workflow.**

**The idea:** A user asks a research question. A planner agent breaks it into sub-questions, researcher agents investigate them in parallel using web search, a critic reviews the findings, and a writer produces a final report with verified citations. The UI shows every agent working in real time.

**Working style:** Build one feature at a time. Each feature should be shippable, tested, and committed before starting the next.

---

## Tech Stack

- **Frontend:** Next.js, TypeScript, Tailwind CSS
- **Backend:** Next.js API routes / Node.js (TypeScript)
- **AI:** Claude API with tool use
- **Search:** a web search API (e.g., Tavily or Brave Search) plus page fetching
- **Validation:** Zod schemas for all agent inputs and outputs
- **Streaming:** Server-Sent Events (SSE)
- **Background jobs:** Inngest (added in Feature 7)
- **Database:** PostgreSQL (e.g., Supabase or Neon)
- **Deployment:** Vercel

---

## Ground Rules for Every Feature

- One feature per working session with Claude Code
- Define the "done when" checks before writing code
- Write tests for the core logic of each feature
- Commit and deploy when a feature is done, so there is always a working version live
- Keep a short `DECISIONS.md` log of architecture choices (this becomes interview and case-study material)

---

## Feature 0 — Project Setup

**Goal:** A clean, deployable skeleton.

**Build:**

- Next.js + TypeScript project with linting, formatting, and a test runner (Vitest or Jest)
- Environment variable handling for API keys
- Deploy an empty landing page to Vercel

**Done when:** The empty app is live on a public URL and tests run locally and in CI.

**Note:** Postgres was originally set up here. It moved to Feature 7 (2026-09-22) — a connection with no schema and no reads can't be meaningfully verified, and by Feature 7 the real shape of runs, steps, and reports is known. See `DECISIONS.md`.

---

## Feature 1 — Single-Agent Baseline

**Goal:** Prove the full request path works end to end before adding complexity.

**Build:**

- A text box where the user submits a question
- One Claude call that answers it
- Stream the answer to the browser via SSE
- Define a shared **event schema** now (e.g., `agent_started`, `agent_progress`, `agent_finished`, `run_failed`) — every later feature emits these same events

**Done when:** A question streams back an answer in the browser, and events follow the defined schema.

**Why it matters:** The event schema is the backbone of the live UI later. Getting it right early avoids a rewrite.

---

## Feature 2 — Researcher Agent with Web Search

**Goal:** One agent that can actually research instead of answering from memory.

**Build:**

- Give the agent two tools: `search(query)` and `fetch_page(url)`
- The agent returns findings plus the list of sources it fetched
- Validate its output against a Zod schema

**Done when:** Asking a current-events question returns findings with real, fetched source URLs.

---

## Feature 3 — Planner Agent

**Goal:** Break a broad question into focused sub-questions.

**Build:**

- Planner takes the user's question and returns 2–3 sub-questions as structured JSON
- Schema validation, with one retry if the output is malformed
- Show the plan in the UI as soon as it's ready

**Done when:** Varied questions produce sensible, non-overlapping sub-questions, and malformed output is handled gracefully.

**Note:** originally 2–5 sub-questions. Lowered to 2–3 during Feature 4 (2026-09-22) because each sub-question becomes a parallel researcher and a wave has to finish inside Vercel's 60s request budget. See `DECISIONS.md`.

---

## Feature 4 — Parallel Researchers

**Goal:** Fan out the plan to multiple researchers at once.

**Build:**

- Spawn one researcher per sub-question, running in parallel
- A concurrency limit (e.g., max 3 at a time)
- Per-agent timeout
- If one researcher fails or returns nothing useful, the run continues and the failure is recorded

**Done when:** A run with one deliberately failing researcher still completes and reports what's missing.

---

## Feature 5 — Writer Agent with Verified Citations

**Goal:** Turn all findings into one coherent report.

**Build:**

- Writer combines researcher findings into a structured report with inline citations
- **Citation verification:** only allow citations to URLs that a researcher actually fetched; strip or flag anything else
- Render the report cleanly with a sources list

**Done when:** Every citation in the final report maps to a fetched source, and a test proves invented URLs are rejected.

**Why it matters:** This is the strongest "production-minded" talking point in the whole project.

---

## Feature 6 — Live Agent Timeline UI

**Goal:** The showpiece — watch the agents work.

**Build:**

- A timeline or column view showing each agent's status (waiting, working, done, failed)
- Live updates driven by the event stream from Feature 1
- Expandable cards showing what each agent found
- Polished loading states and animations

**Done when:** A visitor can watch a full run unfold in real time and understand what each agent is doing without explanation.

---

## Feature 7 — Background Jobs and Saved History

**Goal:** Make long runs reliable and keep past results.

**Build:**

- Provision Postgres (Supabase or Neon) and wire up the connection — deferred here from Feature 0
- Move orchestration into Inngest so runs survive serverless timeouts
- Store runs, agent steps, and reports in Postgres
- A history page listing past runs, each viewable as a finished report
- Reconnecting to an in-progress run after a page refresh

**Done when:** Refreshing the page mid-run reconnects to the live timeline, and finished runs are browsable later.

---

## Feature 8 — Guardrails and Cost Control

**Goal:** Make it safe to leave a public demo online.

**Build:**

- Per-run limits on tokens, time, and number of agent calls
- Per-visitor rate limiting
- A small set of pre-generated sample reports anyone can browse without triggering new API calls
- Clear, friendly messages when a limit is hit

**Done when:** The demo can't run up an unexpected bill, and a visitor with no quota left still has something to explore.

**Status (2026-09-22):** per-run limits (`budget.ts`), per-visitor rate limiting (`rate-limit.ts`), the sample run, and friendly limit messages are all in. Verified without credits: the rate limiter refuses the 6th request in an hour, and a provider 400 degrades to the sample-run message. The sample-run mechanism landed early, during Feature 6 — `public/fixtures/` plus `useRunStream.replay` already browse a finished run without an API call, so this feature mostly needs more fixtures recorded. The per-run token controls also landed early, during Feature 4 (2026-09-22), after a development session spent ~$4.50 mostly on timed-out runs: prompt caching on the researcher loop, a lower turn ceiling, a smaller page cap, and per-researcher token logging. What remains for this feature is per-visitor rate limiting, the pre-generated sample reports, and the friendly limit messages. See `DECISIONS.md` entries 15 and 16.

---

## Feature 9 — Critic Agent (Bounded Review Loop)

**Goal:** Improve report quality with a self-review step.

**Build:**

- Critic reviews researcher findings for gaps, contradictions, or weak evidence
- It can send specific sub-questions back for more research
- Hard cap on review rounds (e.g., max 2) so it can't loop forever
- Show critic feedback in the timeline

**Done when:** The critic visibly catches and triggers a fix for at least one weak finding in test runs, and never exceeds the round cap.

---

## Feature 10 — Trace and Observability View

**Goal:** Show production thinking, not just a working demo.

**Build:**

- Per-run trace showing each agent's input, output, token usage, latency, and estimated cost
- Run-level totals (total cost, total time, number of calls)

**Done when:** Any run can be inspected step by step with accurate token and cost numbers.

---

## Feature 11 — Human-in-the-Loop Plan Approval

**Goal:** Let the user steer the research before it starts.

**Build:**

- After the planner runs, pause and let the user edit, remove, or add sub-questions
- Option to skip approval for a fully automatic run

**Done when:** Editing the plan changes what gets researched, and the automatic path still works.

---

## Feature 12 — Polish and Launch

**Goal:** Turn the project into a portfolio asset.

**Build:**

- Landing page explaining what the app does, with a "try a sample" button
- README with architecture diagram, setup instructions, and key decisions
- Short case study (problem, architecture, decisions, trade-offs) drawn from `DECISIONS.md`
- 60–90 second screen-recorded demo video
- Add to Upwork portfolio, personal site, GitHub (pinned), and LinkedIn

**Done when:** Someone unfamiliar with the project can understand and try it within 30 seconds of landing on it.

---

## Stretch Features (Optional, After Launch)

- Support multiple AI providers (Claude, GPT, Gemini) with a provider switch
- Export reports to PDF or Markdown
- Expose the research capability as an MCP server
- Shareable public links for finished reports

---

## Suggested Milestones

| Milestone        | Features | Result                                         |
| ---------------- | -------- | ---------------------------------------------- |
| 1 — Working core | 0–5      | End-to-end research with verified citations    |
| 2 — Showpiece    | 6–8      | Live timeline, saved history, safe public demo |
| 3 — Depth        | 9–11     | Critic loop, observability, human-in-the-loop  |
| 4 — Launch       | 12       | Portfolio-ready with case study and video      |

Milestone 2 is already portfolio-worthy. Features 9–11 can be added after it's live.
