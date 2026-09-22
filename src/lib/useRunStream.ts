"use client";

import { useCallback, useRef, useState } from "react";
import { readSSEFrame, splitSSEFrames, type RunEvent } from "./events";
import { initialRunState, reduceRunEvent, type RunState } from "./run-stream";

/**
 * Drives a run from the browser.
 *
 * The request is a POST, so `EventSource` is not an option — this reads the
 * response body directly and feeds each frame through the same schema the
 * server emits. All state shaping lives in `reduceRunEvent`; this hook owns
 * only the transport.
 */
export function useRunStream() {
  const [state, setState] = useState<RunState>(initialRunState);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const start = useCallback(async (question: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ ...initialRunState, question, status: "running" });

    try {
      const response = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const detail = await response
          .json()
          .then((body) => body?.error as string | undefined)
          .catch(() => undefined);
        setState((prev) => ({
          ...prev,
          status: "failed",
          error: detail ?? `Request failed (${response.status}).`,
        }));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = splitSSEFrames(buffer);
        buffer = rest;

        for (const frame of frames) {
          const event = readSSEFrame(frame);
          if (event) setState((prev) => reduceRunEvent(prev, event));
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setState((prev) => ({
        ...prev,
        status: "failed",
        error: error instanceof Error ? error.message : "Connection lost.",
      }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  /**
   * Replays a recorded run at its original pace.
   *
   * Goes through the same reducer as a live run, so the timeline cannot
   * diverge between the two. This is what lets the UI be built and shown
   * without spending an API call, and it is the mechanism Feature 8's
   * pre-generated samples will use.
   */
  const replay = useCallback(async (url: string, speed = 1) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    let fixture: { question: string; events: RunEvent[] };
    try {
      const response = await fetch(url, { signal: controller.signal });
      fixture = await response.json();
    } catch (error) {
      if (controller.signal.aborted) return;
      setState((prev) => ({
        ...prev,
        status: "failed",
        error:
          error instanceof Error ? error.message : "Could not load sample.",
      }));
      return;
    }

    setState({
      ...initialRunState,
      question: fixture.question,
      status: "running",
    });

    const started = Date.now();
    for (const event of fixture.events) {
      const due = started + event.ts / speed - Date.now();
      if (due > 0) {
        await new Promise((resolve) => setTimeout(resolve, due));
      }
      if (controller.signal.aborted) return;
      setState((prev) => reduceRunEvent(prev, event));
    }

    if (abortRef.current === controller) abortRef.current = null;
  }, []);

  return { state, start, replay, stop };
}
