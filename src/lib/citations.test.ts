import { describe, expect, it } from "vitest";
import {
  buildSourceList,
  normalizeUrl,
  verifyCitations,
  type NumberedSource,
} from "./citations";

/**
 * Feature 5's done-when: every citation in the final report maps to a fetched
 * source, and a test proves invented URLs are rejected.
 *
 * This is the file that makes the claim true. If the writer hallucinates a
 * citation, one of these tests is what catches it.
 */

const SOURCES: NumberedSource[] = [
  { index: 1, url: "https://example.com/a", title: "A" },
  { index: 2, url: "https://example.org/b", title: "B" },
];

describe("normalizeUrl", () => {
  it("treats fragment, trailing slash and www as the same page", () => {
    const canonical = normalizeUrl("https://example.com/a");
    expect(normalizeUrl("https://example.com/a/")).toBe(canonical);
    expect(normalizeUrl("https://www.example.com/a")).toBe(canonical);
    expect(normalizeUrl("https://example.com/a#section")).toBe(canonical);
    expect(normalizeUrl("https://EXAMPLE.com/a")).toBe(canonical);
  });

  it("keeps path case, which can be significant", () => {
    expect(normalizeUrl("https://example.com/A")).not.toBe(
      normalizeUrl("https://example.com/a"),
    );
  });

  it("rejects a non-http scheme or a non-URL", () => {
    expect(normalizeUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });
});

describe("buildSourceList", () => {
  it("numbers sources from one and deduplicates across researchers", () => {
    const list = buildSourceList([
      [{ url: "https://example.com/a", title: "A" }],
      // The same page, found by a second researcher in a different form.
      [{ url: "https://www.example.com/a/" }, { url: "https://example.org/b" }],
    ]);

    expect(list.map((s) => s.index)).toEqual([1, 2]);
    expect(list.map((s) => s.url)).toEqual([
      "https://example.com/a",
      "https://example.org/b",
    ]);
    expect(list[0].title).toBe("A");
  });

  it("returns nothing when no researcher read anything", () => {
    expect(buildSourceList([[], []])).toEqual([]);
  });
});

describe("verifyCitations", () => {
  it("rejects an invented URL and keeps the sentence", () => {
    // The headline guarantee. The model cites a page that looks plausible and
    // was never fetched; the claim survives, the citation does not.
    const result = verifyCitations(
      "Costs fell by a third (https://totally-real-source.com/study).",
      SOURCES,
    );

    expect(result.markdown).not.toContain("totally-real-source.com");
    expect(result.markdown).toContain("Costs fell by a third");
    expect(result.rejected).toEqual([
      { text: "https://totally-real-source.com/study", reason: "unknown url" },
    ]);
    expect(result.cited).toEqual([]);
  });

  it("rejects an invented URL hidden in a markdown link", () => {
    const result = verifyCitations(
      "The rule changed in [the official notice](https://fake.gov/notice).",
      SOURCES,
    );

    expect(result.markdown).toBe("The rule changed in the official notice.");
    expect(result.rejected[0].reason).toBe("unknown url");
  });

  it("keeps a citation to a page that was actually fetched", () => {
    const result = verifyCitations(
      "Emissions fell [1]. Demand rose [2].",
      SOURCES,
    );

    expect(result.markdown).toBe("Emissions fell [1]. Demand rose [2].");
    expect(result.rejected).toEqual([]);
    expect(result.cited.map((s) => s.index)).toEqual([1, 2]);
  });

  it("converts a real URL into its source number", () => {
    const result = verifyCitations(
      "See https://example.org/b for the detail.",
      SOURCES,
    );

    expect(result.markdown).toBe("See [2] for the detail.");
    expect(result.cited.map((s) => s.index)).toEqual([2]);
  });

  it("converts a real markdown link into its source number, keeping the text", () => {
    const result = verifyCitations(
      "The [agency report](https://example.com/a) confirms it.",
      SOURCES,
    );

    expect(result.markdown).toBe("The agency report [1] confirms it.");
    expect(result.cited.map((s) => s.index)).toEqual([1]);
  });

  it("rejects a reference past the end of the source list", () => {
    const result = verifyCitations("A bold claim [7].", SOURCES);

    expect(result.markdown).toBe("A bold claim.");
    expect(result.rejected).toEqual([
      { text: "[7]", reason: "no such source" },
    ]);
  });

  it("rejects [0], since sources are numbered from one", () => {
    const result = verifyCitations("Something [0].", SOURCES);

    expect(result.rejected[0].reason).toBe("no such source");
  });

  it("does not leave a citation number pointing at a stripped source", () => {
    // Every surviving [n] must resolve, or the sources list and the prose
    // disagree — which is the failure this whole module exists to prevent.
    const result = verifyCitations(
      "One [1], two [9], three (https://nope.example/x), four [2].",
      SOURCES,
    );

    const remaining = [...result.markdown.matchAll(/\[(\d+)\]/g)].map((m) =>
      Number(m[1]),
    );
    expect(remaining.every((n) => n >= 1 && n <= SOURCES.length)).toBe(true);
    expect(new Set(remaining)).toEqual(new Set([1, 2]));
    expect(result.rejected).toHaveLength(2);
  });

  it("strips everything when no source was ever fetched", () => {
    const result = verifyCitations(
      "Confident claim [1] with https://invented.example/page.",
      [],
    );

    expect(result.markdown).not.toContain("invented.example");
    expect(result.markdown).not.toContain("[1]");
    expect(result.cited).toEqual([]);
    expect(result.rejected).toHaveLength(2);
  });

  it("reports only the sources the writer actually used", () => {
    const result = verifyCitations("Only the first matters [1].", SOURCES);

    expect(result.cited).toHaveLength(1);
    expect(result.cited[0].url).toBe("https://example.com/a");
  });

  it("keeps punctuation tidy after stripping", () => {
    const result = verifyCitations(
      "A claim (https://invented.example/x), and another [9].",
      SOURCES,
    );

    expect(result.markdown).not.toMatch(/\s{2,}/);
    expect(result.markdown).not.toMatch(/\s+[.,]/);
  });

  it("leaves a report with no citations untouched", () => {
    const prose = "Nothing here cites anything at all.";
    const result = verifyCitations(prose, SOURCES);

    expect(result.markdown).toBe(prose);
    expect(result.rejected).toEqual([]);
    expect(result.cited).toEqual([]);
  });
});
