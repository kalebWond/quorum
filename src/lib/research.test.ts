import { describe, expect, it, vi } from "vitest";
import type { RunEventBody } from "./events";
import { ResearchError, runResearchers, type ResearchResult } from "./research";

/**
 * Feature 4's done-when: a run with a deliberately failing researcher still
 * completes and reports what is missing.
 *
 * Proving that against the live API would be both expensive and unreliable —
 * there is no way to make exactly one of three researchers fail on demand. So
 * the researcher itself is stubbed through `runResearchers`' options seam, and
 * what is under test is the orchestration: failure isolation, the timeout, and
 * which failures stop the whole run.
 */

const SUBS = ["one?", "two?", "three?"];

/** Collects emitted events so a test can assert on what the UI would see. */
function recorder() {
  const events: RunEventBody[] = [];
  const emit = (body: RunEventBody) => {
    events.push(body);
  };
  return {
    emit,
    events,
    ofType: <T extends RunEventBody["type"]>(type: T) =>
      events.filter((e) => e.type === type) as Extract<
        RunEventBody,
        { type: T }
      >[],
  };
}

const found = (sources = 1): ResearchResult => ({
  findings: "some findings",
  sources: Array.from({ length: sources }, (_, i) => ({
    url: `https://example.com/${i}`,
  })),
});

describe("runResearchers", () => {
  it("runs one researcher per sub-question, labelled by the sub-question", async () => {
    const rec = recorder();
    const run = vi.fn(async () => found());

    const outcomes = await runResearchers(
      SUBS,
      rec.emit,
      new AbortController().signal,
      { run },
    );

    expect(run).toHaveBeenCalledTimes(3);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(rec.ofType("agent_started").map((e) => e.label)).toEqual(SUBS);
    expect(rec.ofType("agent_failed")).toHaveLength(0);
  });

  it("isolates one failure: the others still finish and it is reported", async () => {
    const rec = recorder();
    const run = vi.fn(async (subQuestion: string) => {
      if (subQuestion === "two?") throw new ResearchError("no sources found");
      return found();
    });

    const outcomes = await runResearchers(
      SUBS,
      rec.emit,
      new AbortController().signal,
      { run },
    );

    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true]);
    // Outcomes stay aligned with their sub-questions, so the route can report
    // exactly which ones went unanswered.
    expect(outcomes.map((o) => o.subQuestion)).toEqual(SUBS);

    const failed = outcomes.find((o) => !o.ok);
    expect(failed && !failed.ok && failed.error).toBe("no sources found");

    const failures = rec.ofType("agent_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toBe("no sources found");
    expect(rec.ofType("agent_finished")).toHaveLength(2);
  });

  it("completes even when every researcher fails", async () => {
    const rec = recorder();
    const run = vi.fn(async () => {
      throw new ResearchError("nothing worked");
    });

    const outcomes = await runResearchers(
      SUBS,
      rec.emit,
      new AbortController().signal,
      { run },
    );

    // The pool itself does not decide that an all-failed run is fatal — the
    // route does. What matters here is that it returns rather than throwing.
    expect(outcomes.every((o) => !o.ok)).toBe(true);
    expect(rec.ofType("agent_failed")).toHaveLength(3);
  });

  it("times a researcher out and says so", async () => {
    const rec = recorder();
    // Never resolves on its own — only the deadline can end it.
    const run = vi.fn(
      (
        _subQuestion: string,
        _agentId: string,
        _emit: unknown,
        signal: AbortSignal,
      ) =>
        new Promise<ResearchResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const outcomes = await runResearchers(
      ["slow?"],
      rec.emit,
      new AbortController().signal,
      { run, timeoutMs: 20 },
    );

    expect(outcomes[0].ok).toBe(false);
    expect(!outcomes[0].ok && outcomes[0].error).toBe("Timed out after 0.02s.");
    expect(rec.ofType("agent_failed")[0].error).toBe("Timed out after 0.02s.");
  });

  it("does not let one researcher's timeout stop the others", async () => {
    const rec = recorder();
    const run = vi.fn(
      (
        subQuestion: string,
        _agentId: string,
        _emit: unknown,
        signal: AbortSignal,
      ) =>
        subQuestion === "two?"
          ? new Promise<ResearchResult>((_resolve, reject) => {
              signal.addEventListener("abort", () =>
                reject(new Error("aborted")),
              );
            })
          : Promise.resolve(found()),
    );

    const outcomes = await runResearchers(
      SUBS,
      rec.emit,
      new AbortController().signal,
      { run, timeoutMs: 20 },
    );

    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true]);
  });

  it("rethrows when the client hangs up, instead of blaming the agents", async () => {
    const rec = recorder();
    const controller = new AbortController();
    const run = vi.fn(
      (
        _subQuestion: string,
        _agentId: string,
        _emit: unknown,
        signal: AbortSignal,
      ) =>
        new Promise<ResearchResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const promise = runResearchers(SUBS, rec.emit, controller.signal, { run });
    controller.abort();

    await expect(promise).rejects.toThrow("aborted");
    // A hung-up client is not an agent failure — nothing is listening anyway.
    expect(rec.ofType("agent_failed")).toHaveLength(0);
  });

  it("hides an unexpected error behind a generic message", async () => {
    const rec = recorder();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn(async () => {
      throw new TypeError("cannot read properties of undefined");
    });

    const outcomes = await runResearchers(
      ["one?"],
      rec.emit,
      new AbortController().signal,
      { run },
    );

    // The visitor must not see an internal stack-trace message...
    expect(!outcomes[0].ok && outcomes[0].error).toBe(
      "This researcher failed.",
    );
    // ...but the operator has to, or a billing failure looks like a timeout.
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it("reports a researcher that read nothing without calling it a failure", async () => {
    const rec = recorder();
    const run = vi.fn(async () => found(0));

    const outcomes = await runResearchers(
      ["one?"],
      rec.emit,
      new AbortController().signal,
      { run },
    );

    expect(outcomes[0].ok).toBe(true);
    expect(rec.ofType("agent_finished")[0].summary).toBe(
      "Answered without reading a source.",
    );
  });
});
