"use client";

import { useState } from "react";
import type { AgentView } from "@/lib/run-stream";

/**
 * One agent in the timeline.
 *
 * Collapsed it answers "who is this and how is it going"; expanded it answers
 * "what did it actually find". Feature 6's done-when is that a visitor
 * understands the run without explanation, so status and role are always
 * visible and the detail is opt-in.
 */

const ROLE_LABEL: Record<AgentView["role"], string> = {
  planner: "Planner",
  researcher: "Researcher",
  critic: "Critic",
  writer: "Writer",
};

const STATUS_STYLE: Record<AgentView["status"], string> = {
  working:
    "border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-200",
  done: "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900",
  failed: "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/40",
};

function StatusDot({ status }: { status: AgentView["status"] }) {
  if (status === "working") {
    return (
      <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={`h-2.5 w-2.5 shrink-0 rounded-full ${
        status === "done" ? "bg-emerald-500" : "bg-red-500"
      }`}
    />
  );
}

export function AgentCard({ agent }: { agent: AgentView }) {
  const [open, setOpen] = useState(false);

  const okSources = agent.sources.filter((s) => s.status === "ok").length;
  const hasDetail =
    agent.text.length > 0 ||
    agent.thinking.length > 0 ||
    agent.sources.length > 0;

  return (
    <article
      className={`rounded-lg border transition-colors ${STATUS_STYLE[agent.status]}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!hasDetail}
        aria-expanded={open}
        className="flex w-full items-start gap-3 p-4 text-left disabled:cursor-default"
      >
        <StatusDot status={agent.status} />

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
              {ROLE_LABEL[agent.role]}
            </span>
            {agent.status === "working" && agent.notes.length > 0 && (
              <span className="truncate text-xs text-zinc-500">
                {agent.notes.at(-1)}
              </span>
            )}
          </span>

          <span className="mt-1 block text-sm leading-snug font-medium">
            {agent.label}
          </span>

          {agent.error && (
            <span className="mt-1 block text-sm text-red-700 dark:text-red-300">
              {agent.error}
            </span>
          )}

          {agent.summary && !agent.error && (
            <span className="mt-1 block text-xs text-zinc-500">
              {agent.summary}
            </span>
          )}
        </span>

        {agent.sources.length > 0 && (
          <span className="shrink-0 text-xs text-zinc-500 tabular-nums">
            {okSources}/{agent.sources.length}
          </span>
        )}

        {hasDetail && (
          <span
            aria-hidden
            className={`shrink-0 text-zinc-400 transition-transform ${open ? "rotate-90" : ""}`}
          >
            ›
          </span>
        )}
      </button>

      {open && hasDetail && (
        <div className="flex flex-col gap-3 border-t border-zinc-200/70 px-4 py-3 dark:border-zinc-800">
          {agent.sources.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm">
              {agent.sources.map((source) => (
                <li key={source.url} className="flex items-baseline gap-2">
                  <span
                    aria-hidden
                    className={`w-3 shrink-0 text-center ${
                      source.status === "ok"
                        ? "text-emerald-600"
                        : source.status === "failed"
                          ? "text-red-500"
                          : "text-zinc-400"
                    }`}
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
                    className="min-w-0 flex-1 truncate underline decoration-zinc-300 underline-offset-2"
                  >
                    {source.title ?? source.url}
                  </a>
                  <span className="shrink-0 text-xs text-zinc-500 tabular-nums">
                    {source.status === "failed"
                      ? source.error
                      : source.ms !== undefined
                        ? `${(source.ms / 1000).toFixed(1)}s`
                        : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {agent.thinking && (
            <p className="text-sm whitespace-pre-wrap text-zinc-500 italic">
              {agent.thinking}
            </p>
          )}

          {agent.text && (
            <p className="text-sm leading-relaxed whitespace-pre-wrap">
              {agent.text}
            </p>
          )}
        </div>
      )}
    </article>
  );
}
