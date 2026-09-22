"use client";

import { useCallback, useRef, useState } from "react";
import { readSSEFrame, splitSSEFrames } from "./events";
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

  return { state, start, stop };
}
