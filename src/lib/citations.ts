import type { ResearchSource } from "./research";

/**
 * Citation verification: Feature 5.
 *
 * The writer is told to cite by number, but nothing stops a language model
 * from inventing a plausible URL or citing source [7] when six exist. This
 * module is the boundary that makes "every citation resolves to a page a
 * researcher actually read" a property of the system rather than a hope.
 *
 * Pure, so the guarantee is provable in CI without a model call.
 */

/** One entry in the report's source list, numbered as the writer cites it. */
export type NumberedSource = ResearchSource & { index: number };

/** A citation that was removed, kept so the UI can show what was rejected. */
export type RejectedCitation = {
  text: string;
  reason: "unknown url" | "no such source";
};

export type VerifiedReport = {
  /** The report with every unverifiable citation removed. */
  markdown: string;
  /** Sources the report actually cites, in citation order. */
  cited: NumberedSource[];
  /** What was stripped, and why. */
  rejected: RejectedCitation[];
};

/**
 * Canonical form for comparing two URLs.
 *
 * A writer echoing a source often varies the fragment, a trailing slash, or
 * `www.` — none of which make it a different page. Path case is preserved
 * because it genuinely can be significant.
 */
export function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const text = url.toString();
    return text.endsWith("/") ? text.slice(0, -1) : text;
  } catch {
    return null;
  }
}

/**
 * Builds the numbered source list handed to the writer.
 *
 * Deduplicates by normalized URL, because two researchers landing on the same
 * page is common and must not produce two numbers for one source.
 */
export function buildSourceList(
  sourceGroups: readonly (readonly ResearchSource[])[],
): NumberedSource[] {
  const seen = new Map<string, NumberedSource>();

  for (const group of sourceGroups) {
    for (const source of group) {
      const key = normalizeUrl(source.url);
      if (!key || seen.has(key)) continue;
      seen.set(key, {
        ...source,
        index: seen.size + 1,
        // Prefer the first title seen; a later duplicate may have none.
        title: source.title,
      });
    }
  }

  return [...seen.values()];
}

/** Trailing sentence punctuation is not part of a bare URL. */
function trimUrlPunctuation(url: string): string {
  return url.replace(/[.,;:!?)\]]+$/, "");
}

/**
 * Strips every citation that cannot be traced to a fetched page.
 *
 * Three things are checked, because there are three ways a citation can be
 * wrong: a `[n]` pointing past the end of the source list, a markdown link to
 * a URL nobody fetched, and a bare URL nobody fetched. In each case the
 * surrounding prose is kept — the claim may still be sound, it just loses the
 * citation it did not earn.
 */
export function verifyCitations(
  markdown: string,
  sources: readonly NumberedSource[],
): VerifiedReport {
  const allowed = new Map<string, NumberedSource>();
  for (const source of sources) {
    const key = normalizeUrl(source.url);
    if (key) allowed.set(key, source);
  }

  const rejected: RejectedCitation[] = [];
  const citedIndexes = new Set<number>();
  let output = markdown;

  // Markdown links first, so their URLs are not also matched as bare ones.
  output = output.replace(
    /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
    (match, text: string, url: string) => {
      const key = normalizeUrl(url);
      const source = key ? allowed.get(key) : undefined;
      if (source) {
        citedIndexes.add(source.index);
        return `${text} [${source.index}]`;
      }
      rejected.push({ text: match, reason: "unknown url" });
      return text;
    },
  );

  // Bare URLs.
  output = output.replace(/https?:\/\/[^\s)<>\]]+/g, (match) => {
    const trimmed = trimUrlPunctuation(match);
    const tail = match.slice(trimmed.length);
    const key = normalizeUrl(trimmed);
    const source = key ? allowed.get(key) : undefined;
    if (source) {
      citedIndexes.add(source.index);
      return `[${source.index}]${tail}`;
    }
    rejected.push({ text: trimmed, reason: "unknown url" });
    return tail;
  });

  // Numbered references, including any this pass just wrote.
  output = output.replace(/\[(\d+)\](?!\()/g, (match, digits: string) => {
    const index = Number(digits);
    if (index >= 1 && index <= sources.length) {
      citedIndexes.add(index);
      return match;
    }
    rejected.push({ text: match, reason: "no such source" });
    return "";
  });

  // Tidy the gaps left behind: doubled spaces, and a space before punctuation.
  output = output
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]+$/gm, "");

  return {
    markdown: output,
    cited: sources.filter((source) => citedIndexes.has(source.index)),
    rejected,
  };
}
