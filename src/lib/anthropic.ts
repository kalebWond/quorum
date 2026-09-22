import Anthropic from "@anthropic-ai/sdk";
import { getEnv } from "./env";

/** Every agent in the app uses this model unless a feature says otherwise. */
export const MODEL = "claude-opus-5";

let client: Anthropic | null = null;

/** Lazily constructed so `next build` doesn't need the API key present. */
export function getAnthropic(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: getEnv().ANTHROPIC_API_KEY });
  }
  return client;
}
