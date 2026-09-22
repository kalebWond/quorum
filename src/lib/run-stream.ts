import type { AgentRole, RunEvent } from "./events";

/**
 * Pure reduction of the event stream into renderable state.
 *
 * Kept free of React so it can be tested directly and reused by the Feature 6
 * timeline without re-reading the stream.
 */

export type AgentStatus = "working" | "done" | "failed";

export type SourceStatus = "fetching" | "ok" | "failed";

/** One row of the fetched-source ledger. Feature 5 verifies citations here. */
export type SourceView = {
  url: string;
  status: SourceStatus;
  title?: string;
  ms?: number;
  bytes?: number;
  error?: string;
};

export type AgentView = {
  agentId: string;
  role: AgentRole;
  label: string;
  status: AgentStatus;
  /** Answer text, accumulated from `delta`. */
  text: string;
  /** Summarized reasoning, accumulated from `thinking`. */
  thinking: string;
  notes: string[];
  /** Every URL the agent tried, in the order it first tried them. */
  sources: SourceView[];
  summary?: string;
  error?: string;
};

export type RunStatus = "idle" | "running" | "done" | "failed";

export type RunState = {
  runId?: string;
  question?: string;
  status: RunStatus;
  agents: AgentView[];
  error?: string;
  /** Highest `seq` applied. Also the resume point for a reconnect. */
  lastSeq: number;
};

export const initialRunState: RunState = {
  status: "idle",
  agents: [],
  lastSeq: -1,
};

function patchAgent(
  state: RunState,
  agentId: string,
  patch: (agent: AgentView) => AgentView,
): AgentView[] {
  return state.agents.map((agent) =>
    agent.agentId === agentId ? patch(agent) : agent,
  );
}

export function reduceRunEvent(state: RunState, event: RunEvent): RunState {
  // A reconnect replays frames the client has already applied, and `delta`
  // accumulates — applying one twice would duplicate text in the answer.
  // Scoped to the run: `seq` restarts at 0 for each run, so a new run's
  // opening events must not be mistaken for replays of the previous one.
  if (state.runId === event.runId && event.seq <= state.lastSeq) return state;

  const next: RunState = { ...state, lastSeq: event.seq };

  switch (event.type) {
    case "run_started":
      return {
        ...next,
        runId: event.runId,
        question: event.question,
        status: "running",
        agents: [],
        error: undefined,
      };

    case "agent_started":
      return {
        ...next,
        agents: [
          ...state.agents,
          {
            agentId: event.agentId,
            role: event.role,
            label: event.label,
            status: "working",
            text: "",
            thinking: "",
            notes: [],
            sources: [],
          },
        ],
      };

    case "agent_progress":
      return {
        ...next,
        agents: patchAgent(state, event.agentId, (agent) => ({
          ...agent,
          text: agent.text + (event.delta ?? ""),
          thinking: agent.thinking + (event.thinking ?? ""),
          notes: event.note ? [...agent.notes, event.note] : agent.notes,
        })),
      };

    case "agent_source":
      // Upsert by url: the `fetching` row is replaced in place by its
      // `ok`/`failed` result, so a source never appears twice in the list.
      return {
        ...next,
        agents: patchAgent(state, event.agentId, (agent) => {
          const source: SourceView = {
            url: event.url,
            status: event.status,
            title: event.title,
            ms: event.ms,
            bytes: event.bytes,
            error: event.error,
          };
          const index = agent.sources.findIndex((s) => s.url === event.url);
          return {
            ...agent,
            sources:
              index === -1
                ? [...agent.sources, source]
                : agent.sources.map((s, i) =>
                    i === index ? { ...s, ...source } : s,
                  ),
          };
        }),
      };

    case "agent_finished":
      return {
        ...next,
        agents: patchAgent(state, event.agentId, (agent) => ({
          ...agent,
          status: "done",
          summary: event.summary,
        })),
      };

    case "agent_failed":
      // Deliberately does not fail the run: from Feature 4 onward a single
      // researcher can fail while the rest of the run continues.
      return {
        ...next,
        agents: patchAgent(state, event.agentId, (agent) => ({
          ...agent,
          status: "failed",
          error: event.error,
        })),
      };

    case "run_finished":
      return { ...next, status: "done" };

    case "run_failed":
      return { ...next, status: "failed", error: event.error };
  }
}

export function reduceRunEvents(
  state: RunState,
  events: readonly RunEvent[],
): RunState {
  return events.reduce(reduceRunEvent, state);
}
