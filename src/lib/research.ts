import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getAnthropic, MODEL } from "./anthropic";
import type { RunBudget } from "./budget";
import { mapWithLimit } from "./concurrency";
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

/**
 * Bounds the agentic loop.
 *
 * Five is enough for the intended shape — search, read, read, read, answer.
 * Every extra turn re-sends the whole conversation, so a high ceiling does not
 * buy thoroughness so much as permit expensive flailing.
 */
const MAX_TURNS = 5;
/**
 * Bounds retrieval per researcher.
 *
 * Deliberately small. A researcher now answers one narrow sub-question, not
 * the whole question, so it needs a couple of good pages rather than a survey
 * — and `MAX_PARALLEL` of these run at once against one 60s budget.
 */
const MAX_FETCHES = 3;
/** Searches per researcher. Same reasoning as `MAX_FETCHES`. */
const MAX_SEARCHES = 2;

/**
 * Researchers in flight at once.
 *
 * The planner caps a plan at 3, so today this never throttles. It is a real
 * limit rather than a formality because Feature 11 lets the user add
 * sub-questions, at which point the plan can outgrow the budget.
 */
const MAX_PARALLEL = 3;

/**
 * Wall-clock ceiling for one researcher.
 *
 * Sized against the 60s request budget: the planner takes ~5s, and every
 * researcher runs in the same wave, so the slowest one sets the total.
 */
const RESEARCHER_TIMEOUT_MS = 45_000;

const SYSTEM_PROMPT = [
  "You are a researcher agent for Quorum, assigned one narrow sub-question.",
  "Search, read the two or three most promising pages, then report what you found.",
  "Use web_search to find candidates and fetch_page to actually read them —",
  "search snippets alone are not evidence.",
  "Ground every specific claim in a page you fetched, and name the source inline.",
  "Never cite a URL you did not fetch successfully.",
  "If the evidence is thin or contradictory, say so plainly rather than papering over it.",
  "Report findings as tight bullet points, not an essay: a writer agent turns",
  "several researchers' findings into the final report, so prose here is wasted",
  "work and slows the whole run down.",
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
    max_uses: MAX_SEARCHES,
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
  budget: RunBudget,
): Promise<ResearchResult> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: question },
  ];
  /** url -> source, insertion ordered. Only successful fetches land here. */
  const ledger = new Map<string, ResearchSource>();
  let findings = "";
  let fetches = 0;
  /**
   * Token tally across turns.
   *
   * Logged when the researcher ends so a single live run shows whether the
   * cache is being hit. `cacheRead` staying at zero across turns means a
   * silent invalidator crept into the prefix — see DECISIONS 15.
   */
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  emit({ type: "agent_progress", agentId, note: "Thinking…" });

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Claimed before the request. A researcher that cannot afford another
    // turn stops with what it has rather than failing the run.
    try {
      budget.beginCall();
    } catch {
      emit({
        type: "agent_progress",
        agentId,
        note: "Stopped early — the run reached a limit",
      });
      break;
    }

    const stream = getAnthropic().messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive", display: "summarized" },
      system: SYSTEM_PROMPT,
      tools,
      messages,
      // The single biggest cost lever in this loop. The API is stateless, so
      // every turn re-sends the whole conversation — and by the last turn that
      // is several fetched pages. Caching the prefix makes each re-send a
      // ~0.1x read instead of full price. Render order is tools -> system ->
      // messages, and all three are append-only here, so the prefix stays
      // stable and the next turn hits what this one wrote.
      cache_control: { type: "ephemeral" },
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

    usage.input += message.usage.input_tokens;
    usage.output += message.usage.output_tokens;
    usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;
    budget.record({
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
      cacheRead: message.usage.cache_read_input_tokens ?? 0,
      cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
    });

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

  // Cheap observability until Feature 10 does this properly. A timed-out
  // researcher is aborted before reaching here, and those still bill — which
  // is exactly why the limits above exist.
  console.log(
    `[researcher ${agentId}] in=${usage.input} out=${usage.output} ` +
      `cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} ` +
      `fetches=${fetches}`,
  );

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

/** What one researcher produced, or why it did not. */
export type ResearcherOutcome = {
  agentId: string;
  subQuestion: string;
} & ({ ok: true; result: ResearchResult } | { ok: false; error: string });

/**
 * Runs one researcher per sub-question: Feature 4.
 *
 * Every researcher is isolated. A timeout, a refusal, or a thrown error marks
 * that one agent failed and leaves the rest of the wave running — the run
 * reports what is missing rather than dying. The only thing that stops
 * everything is the client hanging up, which is re-thrown to the caller.
 */
export async function runResearchers(
  subQuestions: string[],
  emit: EmitFn,
  signal: AbortSignal,
  budget: RunBudget,
  /**
   * Test seam. `runResearcher` lives in this module, so a test cannot stub it
   * through the import graph; and a real 45s deadline cannot be waited out in
   * a unit test. Both defaults are the production values.
   */
  options: { run?: typeof runResearcher; timeoutMs?: number } = {},
): Promise<ResearcherOutcome[]> {
  const { run = runResearcher, timeoutMs = RESEARCHER_TIMEOUT_MS } = options;

  const settled = await mapWithLimit(
    subQuestions,
    MAX_PARALLEL,
    async (subQuestion): Promise<ResearcherOutcome> => {
      const agentId = crypto.randomUUID();
      // The sub-question is the card's heading, so the timeline reads as a
      // list of what is being investigated rather than "Researcher 1, 2, 3".
      emit({
        type: "agent_started",
        agentId,
        role: "researcher",
        label: subQuestion,
      });

      // Fires on the client leaving, this researcher overrunning, or the
      // run's own clock expiring — whichever comes first. Capping by the
      // run budget is what keeps the wave inside Vercel's request ceiling.
      const deadline = AbortSignal.timeout(
        Math.max(1, Math.min(timeoutMs, budget.timeLeftMs())),
      );
      const combined = AbortSignal.any([signal, deadline]);

      try {
        const result = await run(subQuestion, agentId, emit, combined, budget);
        emit({
          type: "agent_finished",
          agentId,
          summary:
            result.sources.length === 0
              ? "Answered without reading a source."
              : `Read ${result.sources.length} source${
                  result.sources.length === 1 ? "" : "s"
                }.`,
        });
        return { ok: true, agentId, subQuestion, result };
      } catch (error) {
        // The client hung up: the whole run is over, not just this agent.
        if (signal.aborted) throw error;

        // The visitor gets a safe summary; the real cause goes to the log,
        // or an unexpected failure is indistinguishable from a timeout.
        if (!deadline.aborted && !(error instanceof ResearchError)) {
          console.error(`[researcher ${agentId}] ${subQuestion}`, error);
        }

        const message = deadline.aborted
          ? `Timed out after ${timeoutMs / 1000}s.`
          : error instanceof ResearchError
            ? error.message
            : "This researcher failed.";

        emit({ type: "agent_failed", agentId, error: message });
        return { ok: false, agentId, subQuestion, error: message };
      }
    },
  );

  // `mapWithLimit` only rejects if a task threw, and the one throw left is the
  // client leaving — so surface it rather than reporting it as agent failure.
  const aborted = settled.find((entry) => entry.status === "rejected");
  if (aborted && aborted.status === "rejected") throw aborted.reason;

  return settled.map((entry) => {
    if (entry.status !== "fulfilled") {
      throw new Error("unreachable: rejections are handled above");
    }
    return entry.value;
  });
}
