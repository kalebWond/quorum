/**
 * Times one run and prints a per-agent breakdown.
 *
 * Reads the `ts` on each SSE frame rather than wall-clock at the reader, so
 * pipe buffering cannot distort the numbers — a lesson from Feature 4, where
 * buffered output made three sequential agents look like three parallel ones.
 *
 *   node scripts/trace-run.mjs "your question"
 *   node scripts/trace-run.mjs "your question" https://quorum.vercel.app
 */

const question = process.argv[2];
const base = process.argv[3] ?? "http://localhost:3000";

if (!question) {
  console.error('usage: node scripts/trace-run.mjs "question" [baseUrl]');
  process.exit(1);
}

const response = await fetch(`${base}/api/research`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question }),
});

if (!response.ok || !response.body) {
  console.error(`HTTP ${response.status}: ${await response.text()}`);
  process.exit(1);
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

let t0 = null;
/** agentId -> { label, started, ended, status, sources } */
const agents = new Map();
let planSize = 0;
let missing = [];
let outcome = "(no terminal event)";
let lastTs = 0;

const at = (ts) => (ts - t0) / 1000;

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });

  const parts = buffer.split("\n\n");
  buffer = parts.pop() ?? "";

  for (const frame of parts) {
    const line = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;

    let e;
    try {
      e = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }

    if (t0 === null) t0 = e.ts;
    lastTs = e.ts;

    switch (e.type) {
      case "agent_started":
        agents.set(e.agentId, {
          label: e.label,
          started: e.ts,
          sources: 0,
          status: "running",
        });
        break;
      case "agent_source":
        if (e.status === "ok") {
          const a = agents.get(e.agentId);
          if (a) a.sources++;
        }
        break;
      case "agent_finished":
      case "agent_failed": {
        const a = agents.get(e.agentId);
        if (a) {
          a.ended = e.ts;
          a.status = e.type === "agent_finished" ? "done" : "failed";
          a.detail = e.error ?? e.summary ?? "";
        }
        break;
      }
      case "plan_ready":
        planSize = e.subQuestions.length;
        break;
      case "run_incomplete":
        missing = e.missing;
        break;
      case "run_finished":
        outcome = missing.length ? "finished with gaps" : "finished";
        break;
      case "run_failed":
        outcome = `FAILED: ${e.error}`;
        break;
    }
  }
}

console.log(`\nplan: ${planSize} sub-questions\n`);

for (const a of agents.values()) {
  const dur = a.ended ? (a.ended - a.started) / 1000 : NaN;
  const bar = Number.isNaN(dur) ? "?" : "█".repeat(Math.round(dur));
  console.log(
    `${String(dur.toFixed(1)).padStart(5)}s  ${a.status.padEnd(7)}` +
      ` src=${a.sources}  start=+${at(a.started).toFixed(1)}s  ${bar}`,
  );
  console.log(`        ${a.label.slice(0, 90)}`);
  if (a.detail) console.log(`        -> ${a.detail}`);
}

console.log(`\ntotal: ${at(lastTs).toFixed(1)}s   ${outcome}`);
if (missing.length) console.log(`missing: ${missing.length} sub-question(s)`);

const total = at(lastTs);
console.log(
  total > 60
    ? `\n!! ${total.toFixed(1)}s exceeds Vercel's 60s ceiling — this run would be killed in production`
    : `\nok: ${total.toFixed(1)}s is inside the 60s ceiling`,
);
