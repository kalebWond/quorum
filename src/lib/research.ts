import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getAnthropic, MODEL } from "./anthropic";
import type { EmitFn } from "./events";
import { fetchPage } from "./fetch-page";

/**
 * The researcher agent: Feature 2.
 *
 * Search runs on Anthropic's servers (`web_search`), retrieval runs here
 * (`fetch_page`). That split is deliberate — owning the fetch is what gives us
 * per-source timings for the live timeline, a real per-fetch timeout, and the
 * ledger of URLs actually read that Feature 5 verifies citations against.
 *
 * The loop is written by hand rather than using the SDK's beta tool runner:
 * `pause_turn` has to be handled explicitly either way (the runner does not
 * auto-resume it, and a server tool makes it likely), and Feature 4 needs
 * timeouts and partial failure to be ours to control.
 */

/**
 * A failure that is safe and useful to show a visitor.
 *
 * Distinguishes "the research didn't pan out" — no readable sources, a refusal
 * — from a bug or a provider fault, which the route reports generically.
 */
export class ResearchError extends Error {}

/** Bounds the agentic loop so a confused model cannot spin. */
const MAX_TURNS = 8;
/** Bounds retrieval cost per run. Fetched pages dominate the token bill. */
const MAX_FETCHES = 6;

const SYSTEM_PROMPT = [
  "You are the researcher agent for Quorum.",
  "Research the user's question using the tools before answering.",
  "Use web_search to find candidate sources, then use fetch_page to actually read",
  "the most promising ones — search snippets alone are not evidence.",
  "Ground every specific claim in a page you fetched, and name the source inline.",
  "Never cite a URL you did not fetch successfully.",
  "If the evidence is thin or contradictory, say so plainly rather than papering over it.",
].join(" ");

const fetchPageInputSchema = z.object({
  url: z.string().url(),
});

/** One successfully read source. This is the ledger Feature 5 checks citations against. */
export type ResearchSource = { url: string; title?: string };

export type ResearchResult = {
  findings: string;
  sources: ResearchSource[];
};

/**
 * Output contract for the agent.
 *
 * Requires findings and nothing else. Requiring at least one fetched source
 * was the original contract, and it was wrong: the answer is streamed to the
 * user token by token, so by the time the source count can be checked they
 * have already read it. Failing the run at that point retracts an answer that
 * was in front of them — on a narrow factual question the model answers from
 * search results alone, correctly, and the run died.
 *
 * Sources are reported rather than enforced. Feature 5 enforces the invariant
 * that actually matters — every *citation* resolves to a fetched page — at the
 * point where it can still be acted on.
 */
const researchResultSchema = z.object({
  findings: z.string().trim().min(1, "the researcher produced no findings"),
  sources: z.array(
    z.object({ url: z.string().url(), title: z.string().optional() }),
  ),
});

/** Tool list. Deliberately not annotated — `Anthropic.Tool` is the custom-tool variant only. */
const tools = [
  {
    type: "web_search_20260209" as const,
    name: "web_search" as const,
    max_uses: 5,
  },
  {
    name: "fetch_page",
    description:
      "Fetch a web page and return its readable text. Use this to actually read a " +
      "source found via web_search before relying on it.",
    // Streams the URL as it is generated so the UI can show the fetch starting.
    // The API stops validating input when this is on, so it is parsed below.
    eager_input_streaming: true,
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "Absolute http(s) URL of the page to read",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Runs one researcher to completion.
 *
 * Emits progress as it goes and returns the validated findings. Throws only on
 * a genuine failure (API error, or output that fails the contract above); the
 * caller turns that into `agent_failed`.
 */
export async function runResearcher(
  question: string,
  agentId: string,
  emit: EmitFn,
  signal: AbortSignal,
  subQuestions: string[] = [],
): Promise<ResearchResult> {
  // Feature 3 uses the plan to steer one researcher. Feature 4 replaces this
  // with one researcher per sub-question, running in parallel.
  const brief = subQuestions.length
    ? `${question}\n\nCover these sub-questions:\n${subQuestions
        .map((sub, index) => `${index + 1}. ${sub}`)
        .join("\n")}`
    : question;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: brief }];
  /** url -> source, insertion ordered. Only successful fetches land here. */
  const ledger = new Map<string, ResearchSource>();
  let findings = "";
  let fetches = 0;

  emit({ type: "agent_progress", agentId, note: "Thinking…" });

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stream = getAnthropic().messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive", display: "summarized" },
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    /** Accumulates streamed tool input, keyed by content block index. */
    const pendingInput = new Map<number, { name: string; json: string }>();

    for await (const event of stream) {
      if (signal.aborted) {
        stream.abort();
        throw new Error("aborted");
      }

      if (event.type === "content_block_start") {
        const block = event.content_block;

        if (block.type === "server_tool_use") {
          pendingInput.set(event.index, { name: block.name, json: "" });
        } else if (block.type === "web_search_tool_result") {
          // Success is a list of results; an error is a single object.
          const content = block.content as unknown;
          if (Array.isArray(content)) {
            emit({
              type: "agent_progress",
              agentId,
              note: `Found ${content.length} result${content.length === 1 ? "" : "s"}`,
            });
          } else {
            const code =
              (content as { error_code?: string } | null)?.error_code ??
              "unknown error";
            emit({
              type: "agent_progress",
              agentId,
              note: `Search failed (${code})`,
            });
          }
        }
        continue;
      }

      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          findings += event.delta.text;
          emit({ type: "agent_progress", agentId, delta: event.delta.text });
        } else if (event.delta.type === "thinking_delta") {
          emit({
            type: "agent_progress",
            agentId,
            thinking: event.delta.thinking,
          });
        } else if (event.delta.type === "input_json_delta") {
          const pending = pendingInput.get(event.index);
          if (pending) pending.json += event.delta.partial_json;
        }
        continue;
      }

      if (event.type === "content_block_stop") {
        // The search query is complete but the server has not run it yet, so
        // this is the moment to announce it.
        const pending = pendingInput.get(event.index);
        if (pending?.name === "web_search") {
          const query = (() => {
            try {
              return (JSON.parse(pending.json) as { query?: string }).query;
            } catch {
              return undefined;
            }
          })();
          emit({
            type: "agent_progress",
            agentId,
            note: query ? `Searching: "${query}"` : "Searching the web…",
          });
        }
        pendingInput.delete(event.index);
      }
    }

    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      throw new ResearchError("The model declined to research this question.");
    }
    if (message.stop_reason === "pause_turn") {
      // A server-side tool hit its iteration limit. Push the paused turn back
      // and re-send; the API resumes from the trailing server_tool_use block.
      messages.push({ role: "assistant", content: message.content });
      continue;
    }

    const toolUses = message.content.filter(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === "tool_use" && block.name === "fetch_page",
    );

    if (message.stop_reason === "max_tokens" && toolUses.length > 0) {
      throw new ResearchError("The researcher's tool input was cut short.");
    }
    if (toolUses.length === 0) break;

    messages.push({ role: "assistant", content: message.content });

    // All results for one assistant turn go back in a single user message —
    // splitting them teaches the model to stop calling tools in parallel.
    const results = await Promise.all(
      toolUses.map(async (toolUse): Promise<Anthropic.ToolResultBlockParam> => {
        // Eager input streaming means the API did not validate this.
        const parsed = fetchPageInputSchema.safeParse(toolUse.input);
        if (!parsed.success) {
          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content: "invalid input: expected { url: string }",
          };
        }

        const { url } = parsed.data;

        if (fetches >= MAX_FETCHES) {
          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content: `fetch limit of ${MAX_FETCHES} pages reached for this run`,
          };
        }
        fetches++;

        emit({ type: "agent_source", agentId, url, status: "fetching" });
        const result = await fetchPage(url);

        if (!result.ok) {
          emit({
            type: "agent_source",
            agentId,
            url,
            status: "failed",
            error: result.error,
            ms: result.ms,
          });
          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content: `could not read ${hostOf(url)}: ${result.error}`,
          };
        }

        emit({
          type: "agent_source",
          agentId,
          // The final URL after redirects is the one that was actually read.
          url: result.url,
          status: "ok",
          title: result.title,
          ms: result.ms,
          bytes: result.bytes,
        });
        ledger.set(result.url, { url: result.url, title: result.title });

        return {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Source: ${result.url}\nTitle: ${result.title ?? "(none)"}\n\n${result.text}`,
        };
      }),
    );

    messages.push({ role: "user", content: results });
  }

  if (ledger.size === 0) {
    // Not a failure, but the user should know the answer rests on search
    // results rather than on anything this agent actually read.
    emit({
      type: "agent_progress",
      agentId,
      note: "Answered from search results without reading a source",
    });
  }

  const validated = researchResultSchema.safeParse({
    findings,
    sources: [...ledger.values()],
  });

  if (!validated.success) {
    throw new ResearchError(
      validated.error.issues[0]?.message ??
        "The researcher returned nothing usable.",
    );
  }

  return validated.data;
}
