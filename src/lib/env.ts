import { z } from "zod";

/**
 * Every environment variable the app reads passes through here.
 *
 * Nothing else in the codebase should touch `process.env` directly — a missing
 * key should fail loudly at the point of use with a readable message, not
 * surface later as an undefined string in an API call.
 */
const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "must be set (see .env.example)"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * Validated environment access.
 *
 * Deliberately lazy: reading at module scope would break `next build`, which
 * imports route modules without the runtime environment present.
 */
export function getEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}
