"use client";

import { useState } from "react";
import { useRunStream } from "@/lib/useRunStream";

/**
 * Feature 1 UI — deliberately plain.
 *
 * Feature 6 replaces this view with the agent timeline, so effort spent on
 * styling here would be thrown away. It exists to prove the stream arrives
 * progressively and that failures surface instead of hanging.
 */
export default function Home() {
  const [question, setQuestion] = useState("");
  const { state, start } = useRunStream();
  const running = state.status === "running";

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-16">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Quorum</h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          Ask a research question and watch the agent work.
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
        <button
          type="submit"
          disabled={running || !question.trim()}
          className="self-start rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {running ? "Researching…" : "Research"}
        </button>
      </form>

      {state.error && (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {state.error}
        </p>
      )}

      {state.plan && (
        <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="text-sm font-medium tracking-wide text-zinc-500 uppercase">
            Plan
          </h2>
          <ol className="mt-2 flex list-decimal flex-col gap-1 pl-5">
            {state.plan.map((subQuestion) => (
              <li key={subQuestion}>{subQuestion}</li>
            ))}
          </ol>
        </section>
      )}

      {state.missing && (
        <p
          role="status"
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          Finished with gaps — nothing was found for: {state.missing.join("; ")}
        </p>
      )}

      {state.agents.map((agent) => (
        <article
          key={agent.agentId}
          className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
        >
          <div className="flex items-baseline justify-between">
            <h2 className="font-medium">{agent.label}</h2>
            <span className="text-xs tracking-wide text-zinc-500 uppercase">
              {agent.status}
            </span>
          </div>

          {agent.thinking && !agent.text && (
            <p className="text-sm whitespace-pre-wrap text-zinc-500 italic">
              {agent.thinking}
            </p>
          )}

          {agent.notes.length > 0 && !agent.text && (
            <p className="text-sm text-zinc-500">{agent.notes.at(-1)}</p>
          )}

          {agent.sources.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm">
              {agent.sources.map((source) => (
                <li key={source.url} className="flex items-baseline gap-2">
                  <span
                    aria-hidden
                    className="w-3 shrink-0 text-center text-zinc-400"
                  >
                    {source.status === "ok"
                      ? "✓"
                      : source.status === "failed"
                        ? "✗"
                        : "⟳"}
                  </span>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="truncate underline decoration-zinc-300 underline-offset-2"
                  >
                    {source.title ?? source.url}
                  </a>
                  <span className="shrink-0 text-xs text-zinc-500">
                    {source.status === "failed"
                      ? source.error
                      : source.ms !== undefined
                        ? `${(source.ms / 1000).toFixed(1)}s`
                        : null}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {agent.text && (
            <p className="leading-relaxed whitespace-pre-wrap">{agent.text}</p>
          )}

          {agent.error && (
            <p className="text-sm text-red-700 dark:text-red-300">
              {agent.error}
            </p>
          )}
        </article>
      ))}
    </main>
  );
}
