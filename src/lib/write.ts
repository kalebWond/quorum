import Anthropic from "@anthropic-ai/sdk";
import { getAnthropic, MODEL } from "./anthropic";
import type { RunBudget } from "./budget";
import {
  buildSourceList,
  verifyCitations,
  type NumberedSource,
  type VerifiedReport,
} from "./citations";
import type { EmitFn } from "./events";
import type { ResearcherOutcome } from "./research";

/**
 * The writer agent: Feature 5.
 *
 * Turns several researchers' findings into one report. What makes the report
 * trustworthy is not this agent — it is `verifyCitations`, which runs over the
 * draft before anyone sees it. The prompt asks for honest citations; the
 * verifier is what guarantees them.
 */

/** A failure that is safe to show a visitor. Mirrors `ResearchError`. */
export class WriteError extends Error {}

/** Enough for a full report plus adaptive thinking. */
const MAX_TOKENS = 16000;

const SYSTEM_PROMPT = [
  "You are the writer agent for Quorum.",
  "Several researchers investigated one sub-question each. Combine their",
  "findings into a single coherent report that answers the original question.",
  "Cite with bracketed numbers that match the numbered source list, like [1] or [2].",
  "Cite a source only for a claim it actually supports, and never invent a URL or",
  "a source number — citations are checked against the list, and anything that",
  "does not resolve is stripped from the report before it is shown.",
  "Where the researchers disagree or the evidence is thin, say so rather than",
  "smoothing it over. Where a sub-question went unanswered, say that too.",
  "Use short markdown sections. Do not include a sources list — one is added",
  "for you from the citations that survive checking.",
].join(" ");

export type WriterResult = VerifiedReport & { sources: NumberedSource[] };

/**
 * Builds the writer's brief from what the researchers produced.
 *
 * Failed sub-questions are included by name so the report can acknowledge the
 * gap instead of quietly writing around it.
 */
function buildBrief(
  question: string,
  outcomes: readonly ResearcherOutcome[],
  sources: readonly NumberedSource[],
): string {
  const parts: string[] = [`Original question: ${question}`, ""];

  parts.push("Numbered sources — cite only these:");
  for (const source of sources) {
    parts.push(
      `[${source.index}] ${source.title ?? "(untitled)"} — ${source.url}`,
    );
  }
  parts.push("");

  for (const outcome of outcomes) {
    if (outcome.ok) {
      parts.push(
        `## Sub-question: ${outcome.subQuestion}`,
        outcome.result.findings,
        "",
      );
    } else {
      parts.push(
        `## Sub-question: ${outcome.subQuestion}`,
        `NOT ANSWERED — this researcher failed (${outcome.error}). Say so in the report.`,
        "",
      );
    }
  }

  return parts.join("\n");
}

/**
 * Runs the writer and verifies what it produced.
 *
 * Streams the draft so the report appears as it is written, then runs the
 * verifier over the accumulated text. The verified markdown is returned rather
 * than re-streamed — see DECISIONS 17 for why the UI renders the verified copy
 * rather than the draft it watched arrive.
 */
export async function runWriter(
  question: string,
  outcomes: readonly ResearcherOutcome[],
  agentId: string,
  emit: EmitFn,
  signal: AbortSignal,
  budget: RunBudget,
): Promise<WriterResult> {
  const sources = buildSourceList(
    outcomes.map((outcome) => (outcome.ok ? outcome.result.sources : [])),
  );

  emit({ type: "agent_progress", agentId, note: "Writing the report…" });
  budget.beginCall();

  const stream = getAnthropic().messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive", display: "summarized" },
    system: SYSTEM_PROMPT,
    messages: [
      { role: "user", content: buildBrief(question, outcomes, sources) },
    ],
    cache_control: { type: "ephemeral" },
  });

  let draft = "";

  for await (const event of stream) {
    if (signal.aborted) {
      stream.abort();
      throw new Error("aborted");
    }
    if (event.type !== "content_block_delta") continue;

    if (event.delta.type === "text_delta") {
      draft += event.delta.text;
      emit({ type: "agent_progress", agentId, delta: event.delta.text });
    } else if (event.delta.type === "thinking_delta") {
      emit({ type: "agent_progress", agentId, thinking: event.delta.thinking });
    }
  }

  const message: Anthropic.Message = await stream.finalMessage();
  budget.record({
    input: message.usage.input_tokens,
    output: message.usage.output_tokens,
    cacheRead: message.usage.cache_read_input_tokens ?? 0,
    cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
  });

  if (message.stop_reason === "refusal") {
    throw new WriteError("The model declined to write this report.");
  }
  if (!draft.trim()) {
    throw new WriteError("The writer produced an empty report.");
  }

  const verified = verifyCitations(draft, sources);

  if (verified.rejected.length > 0) {
    // Worth surfacing: this is the guarantee doing visible work.
    emit({
      type: "agent_progress",
      agentId,
      note: `Removed ${verified.rejected.length} unverifiable citation${
        verified.rejected.length === 1 ? "" : "s"
      }`,
    });
  }

  return { ...verified, sources };
}
