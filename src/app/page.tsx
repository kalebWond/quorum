"use client";

import { useState } from "react";
import Markdown from "react-markdown";
import { useRunStream } from "@/lib/useRunStream";
import { AgentCard } from "./AgentCard";

/**
 * Feature 6: the live agent timeline.
 *
 * The run reads top to bottom in the order it happens — question, plan,
 * researchers, report — so a visitor can follow it without being told what a
 * planner or a researcher is. The sample button replays a recorded run
 * through the same reducer, which is what makes the page demonstrable
 * without an API call.
 */
export default function Home() {
  const [question, setQuestion] = useState("");
  const { state, start, replay } = useRunStream();
  const running = state.status === "running";

  const researchers = state.agents.filter((a) => a.role === "researcher");
  const planner = state.agents.find((a) => a.role === "planner");
  const writer = state.agents.find((a) => a.role === "writer");

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-12">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Quorum</h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          A planner splits your question, researchers investigate each part in
          parallel, and a writer produces a report where every citation is
          checked against a page that was actually read.
        </p>
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (question.trim() && !running) start(question);
        }}
        className="flex flex-col gap-3"
      >
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          rows={3}
          placeholder="What would you like researched?"
          className="w-full resize-y rounded-lg border border-zinc-300 bg-white p-3 text-base outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={running || !question.trim()}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {running ? "Researching…" : "Research"}
          </button>
          <button
            type="button"
            disabled={running}
            onClick={() => replay("/fixtures/sample-run.json")}
            className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium disabled:opacity-40 dark:border-zinc-700"
          >
            Watch a sample run
          </button>
        </div>
      </form>

      {state.error && (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {state.error}
        </p>
      )}

      {state.question && (
        <section className="flex flex-col gap-3">
          {planner && <AgentCard agent={planner} />}

          {state.plan && (
            <ol className="ml-4 flex list-decimal flex-col gap-1 border-l border-zinc-200 py-1 pl-6 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
              {state.plan.map((subQuestion) => (
                <li key={subQuestion}>{subQuestion}</li>
              ))}
            </ol>
          )}

          {researchers.map((agent) => (
            <AgentCard key={agent.agentId} agent={agent} />
          ))}

          {state.missing && (
            <p
              role="status"
              className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
            >
              Finished with gaps — nothing was found for:{" "}
              {state.missing.join("; ")}
            </p>
          )}

          {writer && <AgentCard agent={writer} />}
        </section>
      )}

      {state.report && (
        <section className="flex flex-col gap-4 rounded-lg border border-zinc-300 p-5 dark:border-zinc-700">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium tracking-wide text-zinc-500 uppercase">
              Report
            </h2>
            {state.report.rejected.length > 0 && (
              <span
                title={state.report.rejected.map((r) => r.text).join("\n")}
                className="text-xs text-amber-700 dark:text-amber-400"
              >
                {state.report.rejected.length} unverifiable citation
                {state.report.rejected.length === 1 ? "" : "s"} removed
              </span>
            )}
          </div>

          {/* The writer emits markdown; react-markdown renders it without
              dangerouslySetInnerHTML, which matters because the content is
              model output. */}
          <div className="flex flex-col gap-3 leading-relaxed [&_h2]:mt-2 [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_strong]:font-semibold">
            <Markdown>{state.report.markdown}</Markdown>
          </div>

          {state.report.sources.length > 0 && (
            <ol className="flex flex-col gap-1 border-t border-zinc-200 pt-3 text-sm dark:border-zinc-800">
              {state.report.sources.map((source) => (
                <li key={source.index} className="flex gap-2">
                  <span className="shrink-0 text-zinc-500 tabular-nums">
                    [{source.index}]
                  </span>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="truncate underline decoration-zinc-300 underline-offset-2"
                  >
                    {source.title ?? source.url}
                  </a>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </main>
  );
}
