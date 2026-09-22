/**
 * Builds the replay fixture used by the sample run.
 *
 *   node scripts/make-fixture.mjs > public/fixtures/sample-run.json
 *
 * Provenance matters here, so it is stated plainly: the source URLs, titles,
 * fetch timings, failure reasons and reasoning text below were captured from a
 * real run on 2026-09-22 (the EU AI Act question, Feature 2). The multi-agent
 * shape around them — planner, three parallel researchers, writer — is
 * assembled here, because no full run has been recorded yet.
 *
 * Once a real end-to-end run can be recorded, replace this with a straight
 * conversion of that capture and delete the assembly. Until then the fixture
 * is for developing and demonstrating the timeline, not evidence that a run
 * produced these results.
 */

const QUESTION = "What did the EU announce about AI regulation in 2026?";

const SUBS = [
  "What transparency rules under the EU AI Act took effect in 2026, and who enforces them?",
  "What did the Digital Omnibus on AI change about the high-risk AI timeline?",
  "How have industry and member states responded to the 2026 changes?",
];

/** Real pages, with the timings and outcomes actually observed. */
const SOURCES = [
  {
    url: "https://digital-strategy.ec.europa.eu/en/news/commission-starts-enforcing-ai-act-rules-and-new-transparency-requirements-2-august",
    title:
      "Commission starts enforcing AI Act rules and new transparency requirements on 2 August",
    ms: 669,
    bytes: 50865,
  },
  {
    url: "https://www.gibsondunn.com/eu-ai-act-omnibus-agreement-postponed-high-risk-deadlines-and-other-key-changes/",
    title:
      "EU AI Act Omnibus Agreement — Postponed High-Risk Deadlines and Other Key Changes",
    ms: 1231,
    bytes: 201770,
  },
  {
    url: "https://www.europarl.europa.eu/news/en/press-room/2026-digital-omnibus-vote",
    title: "Parliament endorses the Digital Omnibus on AI",
    ms: 842,
    bytes: 38210,
  },
];

/** Real failures observed on the same run. */
const FAILURES = [
  {
    url: "https://www.consilium.europa.eu/en/press/press-releases/2026/05/07/artificial-intelligence-council-and-parliament-agree-to-simplify-and-streamline-rules/",
    error: "HTTP 403",
    ms: 175,
  },
  {
    url: "https://ec.europa.eu/commission/presscorner/detail/en/ip_26_1714",
    error: "page had no readable text",
    ms: 535,
  },
];

const FINDINGS = [
  "- New transparency rules took effect 2 August 2026; the Commission's AI Office enforces them with national authorities.\n- Systems such as chatbots, voice assistants and AI agents must disclose that a user is interacting with AI, unless it is already obvious.\n- The Commission published a first list of 180+ organisations signed up to the Code of Practice on transparency of AI-generated content.",
  "- The Digital Omnibus on AI postponed high-risk obligations: standalone Annex III systems to 2 December 2027, AI embedded in regulated products to 2 August 2028.\n- Article 50's transparency duties were NOT delayed; systems placed on the market before 2 August 2026 get until 2 December 2026 for the watermarking obligation.\n- Adopted as Regulation (EU) 2026/1744, in force 27 July 2026.",
  "- The package passed Parliament 423-57 with 174 abstentions, which industry groups read as broad support for recalibration rather than retreat.\n- Analysts frame the delay as driven by unfinished harmonised standards, not by a change of policy direction.",
];

/** The writer's draft, including one citation the verifier must strip. */
const DRAFT = `## What changed

The EU did two things in 2026 that pull in opposite directions.

**Transparency rules went live.** From 2 August 2026 the Commission's AI Office began enforcing the AI Act's disclosure requirements [1]. Chatbots, voice assistants and AI agents must now tell users they are AI unless that is already obvious [1].

**The heaviest rules were pushed back.** The Digital Omnibus on AI deferred high-risk obligations to December 2027 for standalone systems and August 2028 for AI inside regulated products [2]. Article 50's transparency duties were deliberately left in place [2].

**The politics.** Parliament endorsed the package 423-57 [3]. One industry survey found 68% of providers were unprepared for the original deadline (https://ai-readiness-institute.example/survey-2026), which is often cited as the practical reason for the delay.

## What this means

The framework was recalibrated, not abandoned: disclosure obligations are live and enforced, while the compliance-heavy high-risk regime slipped by roughly sixteen months.`;

/** What `verifyCitations` leaves behind: the claim stays, the citation goes. */
const REPORT = DRAFT.replace(
  " (https://ai-readiness-institute.example/survey-2026)",
  "",
);

const THINKING = [
  "The question spans a whole year of policy, so it needs splitting by theme rather than by date — enforcement, the legislative change, and reaction.",
  "Search results mention both an August enforcement date and a separate omnibus regulation. Those are different instruments; I should read the Commission's own page rather than trust a summary.",
  "The law firm analysis gives the dates precisely. Worth checking it against the Commission announcement before relying on it.",
];

/**
 * Events are composed one agent at a time but the researchers overlap, so
 * they are collected with their intended time and ordered at the end. `seq`
 * has to follow wall-clock order, not authoring order, because the client
 * drops anything at or below the highest `seq` it has already applied.
 */
const pending = [];
const RUN_ID = "sample-run";

/** `at` is milliseconds from the start of the run. */
function push(body, at) {
  pending.push({ body, at: Math.round(at) });
}

function streamText(agentId, text, from, durationMs) {
  // Chunked the way the API delivers it: a few words at a time.
  const chunks = text.match(/\S+\s*/g) ?? [];
  const step = durationMs / chunks.length;
  chunks.forEach((chunk, i) => {
    push(
      { type: "agent_progress", agentId, delta: chunk },
      Math.round(from + i * step),
    );
  });
}

const PLANNER = "agent-planner";
const WRITER = "agent-writer";
const RESEARCHERS = ["agent-r1", "agent-r2", "agent-r3"];

push({ type: "run_started", question: QUESTION }, 0);
push(
  {
    type: "agent_started",
    agentId: PLANNER,
    role: "planner",
    label: "Planner",
  },
  60,
);
push({ type: "agent_progress", agentId: PLANNER, note: "Planning…" }, 120);
streamText(PLANNER, THINKING[0], 400, 2200);
push({ type: "plan_ready", subQuestions: SUBS }, 3200);
push(
  {
    type: "agent_finished",
    agentId: PLANNER,
    summary: `Split into ${SUBS.length} sub-questions.`,
  },
  3250,
);

// Three researchers, started together and finishing at different times.
RESEARCHERS.forEach((agentId, i) => {
  const base = 3300 + i * 40;
  push(
    { type: "agent_started", agentId, role: "researcher", label: SUBS[i] },
    base,
  );
  push({ type: "agent_progress", agentId, note: "Thinking…" }, base + 100);
  push(
    {
      type: "agent_progress",
      agentId,
      note: `Searching: "${["EU AI Act transparency August 2026", "digital omnibus AI high-risk delay", "industry response EU AI Act 2026"][i]}"`,
    },
    base + 1800 + i * 300,
  );
  push(
    { type: "agent_progress", agentId, note: "Found 9 results" },
    base + 4200 + i * 400,
  );

  // Researcher 2 hits the two real failures before finding a good page.
  if (i === 1) {
    FAILURES.forEach((failure, j) => {
      push(
        { type: "agent_source", agentId, url: failure.url, status: "fetching" },
        base + 5000 + j * 120,
      );
      push(
        {
          type: "agent_source",
          agentId,
          url: failure.url,
          status: "failed",
          error: failure.error,
          ms: failure.ms,
        },
        base + 5000 + j * 120 + failure.ms,
      );
    });
  }

  const source = SOURCES[i];
  push(
    { type: "agent_source", agentId, url: source.url, status: "fetching" },
    base + 6200,
  );
  push(
    {
      type: "agent_source",
      agentId,
      url: source.url,
      status: "ok",
      title: source.title,
      ms: source.ms,
      bytes: source.bytes,
    },
    base + 6200 + source.ms,
  );

  streamText(agentId, FINDINGS[i], base + 7600, 3000 + i * 900);
  push(
    { type: "agent_finished", agentId, summary: "Read 1 source." },
    base + 11000 + i * 1000,
  );
});

const writerStart = 15200;
push(
  { type: "agent_started", agentId: WRITER, role: "writer", label: "Writer" },
  writerStart,
);
push(
  { type: "agent_progress", agentId: WRITER, note: "Writing the report…" },
  writerStart + 80,
);
streamText(WRITER, DRAFT, writerStart + 900, 6000);
push(
  {
    type: "agent_progress",
    agentId: WRITER,
    note: "Removed 1 unverifiable citation",
  },
  writerStart + 7100,
);
push(
  {
    type: "report_ready",
    markdown: REPORT,
    sources: SOURCES.map((source, i) => ({
      index: i + 1,
      url: source.url,
      title: source.title,
    })),
    rejected: [
      {
        text: "https://ai-readiness-institute.example/survey-2026",
        reason: "unknown url",
      },
    ],
  },
  writerStart + 7200,
);
push(
  {
    type: "agent_finished",
    agentId: WRITER,
    summary: `Cited ${SOURCES.length} of ${SOURCES.length} sources.`,
  },
  writerStart + 7250,
);
push({ type: "run_finished" }, writerStart + 7300);

// Stable sort by time, then number in that order.
const events = pending
  .map((entry, index) => ({ ...entry, index }))
  .sort((a, b) => a.at - b.at || a.index - b.index)
  .map((entry, seq) => ({ ...entry.body, runId: RUN_ID, seq, ts: entry.at }));

process.stdout.write(JSON.stringify({ question: QUESTION, events }, null, 2));
