import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getAnthropic, MODEL } from "./anthropic";
import type { RunBudget } from "./budget";
import type { EmitFn } from "./events";

/**
 * The planner agent: Feature 3.
 *
 * Splits one broad question into a handful of focused sub-questions. Feature 4
 * turns each into its own researcher, so the value here is in the split being
 * genuinely non-overlapping — two researchers answering the same question is
 * wasted money and a duplicated report section.
 */

/** A failure that is safe to show a visitor. Mirrors `ResearchError`. */
export class PlanError extends Error {}

/** Room for adaptive thinking plus a small JSON body. */
const MAX_TOKENS = 8000;
/** The plan is malformed at most once before the run gives up. */
const MAX_ATTEMPTS = 2;

/**
 * The plan's shape, in one place.
 *
 * Sent to the API as the output format *and* used to validate what comes back.
 * Structured outputs make a malformed plan unlikely, not impossible — a
 * response truncated at `max_tokens` is still cut-off JSON — so this stays the
 * boundary rather than being trusted blindly.
 */
export const planSchema = z.object({
  subQuestions: z
    .array(z.string().trim().min(1))
    .min(2, "a plan needs at least 2 sub-questions")
    .max(3, "a plan may have at most 3 sub-questions"),
});

export type Plan = z.infer<typeof planSchema>;

const SYSTEM_PROMPT = [
  "You are the planner agent for Quorum.",
  "Break the user's question into 2-3 focused sub-questions that can each be",
  "researched independently, and that together cover the original question.",
  "Each sub-question must stand alone — a researcher will see it without the",
  "others and without the original question.",
  "Do not overlap: two sub-questions that would return the same sources are one",
  "sub-question. Prefer fewer, sharper questions over more, vaguer ones.",
].join(" ");

/**
 * Turns raw model output into a plan.
 *
 * Pure, so the malformed-output path Feature 3 requires can be tested without
 * spending a model call. Falls back to locating the first JSON object in the
 * text, which covers a model that wraps its answer in prose or code fences.
 */
export function parsePlan(
  raw: string,
): { ok: true; plan: Plan } | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: false, error: "the planner returned nothing" };

  const candidates = [text];
  const embedded = text.match(/\{[\s\S]*\}/);
  if (embedded) candidates.push(embedded[0]);

  for (const candidate of candidates) {
    let json: unknown;
    try {
      json = JSON.parse(candidate);
    } catch {
      continue;
    }

    const result = planSchema.safeParse(json);
    if (result.success) return { ok: true, plan: result.data };
    return {
      ok: false,
      error:
        result.error.issues[0]?.message ?? "the plan did not match the schema",
    };
  }

  return { ok: false, error: "the planner did not return JSON" };
}

/**
 * Runs the planner to completion, retrying once on malformed output.
 *
 * The retry sends the parse error back as a follow-up turn rather than
 * re-asking cold — the model corrects a specific mistake far more reliably
 * than it avoids an unnamed one.
 */
export async function runPlanner(
  question: string,
  agentId: string,
  emit: EmitFn,
  signal: AbortSignal,
  budget: RunBudget,
): Promise<Plan> {
  emit({ type: "agent_progress", agentId, note: "Planning…" });

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: question },
  ];

  let lastError = "the planner returned nothing usable";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Claimed before the request, so a run already over budget spends nothing.
    budget.beginCall();

    const stream = getAnthropic().messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive", display: "summarized" },
      system: SYSTEM_PROMPT,
      output_config: { format: zodOutputFormat(planSchema) },
      messages,
    });

    let raw = "";

    for await (const event of stream) {
      if (signal.aborted) {
        stream.abort();
        throw new Error("aborted");
      }
      if (event.type !== "content_block_delta") continue;

      if (event.delta.type === "text_delta") {
        // The JSON body itself is not shown — the plan lands as one event once
        // it is valid, so the UI never renders a half-written question.
        raw += event.delta.text;
      } else if (event.delta.type === "thinking_delta") {
        emit({
          type: "agent_progress",
          agentId,
          thinking: event.delta.thinking,
        });
      }
    }

    const message = await stream.finalMessage();
    budget.record({
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
      cacheRead: message.usage.cache_read_input_tokens ?? 0,
      cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
    });

    if (message.stop_reason === "refusal") {
      throw new PlanError("The model declined to plan this question.");
    }

    const parsed = parsePlan(raw);
    if (parsed.ok) return parsed.plan;

    lastError = parsed.error;

    if (attempt < MAX_ATTEMPTS) {
      emit({
        type: "agent_progress",
        agentId,
        note: `Plan was malformed (${lastError}) — retrying`,
      });
      messages.push(
        { role: "assistant", content: raw || "(no output)" },
        {
          role: "user",
          content:
            `That response was rejected: ${lastError}. ` +
            `Reply with only the JSON object, matching the schema exactly.`,
        },
      );
    }
  }

  throw new PlanError(
    `The planner could not produce a usable plan: ${lastError}.`,
  );
}
