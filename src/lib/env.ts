import { z } from "zod";

/**
 * Server env, validated lazily (so `next build` doesn't need runtime secrets).
 * Optional integrations are blank → the corresponding mock adapter is used.
 */
const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be set (openssl rand -base64 32)"),
  ENCRYPTION_KEY: z.string().min(1, "ENCRYPTION_KEY must be set (openssl rand -base64 32)"),
  ENCRYPTION_KEY_PREVIOUS: optional,
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  AUTH_GOOGLE_ID: optional,
  AUTH_GOOGLE_SECRET: optional,
  AUTH_GITHUB_ID: optional,
  AUTH_GITHUB_SECRET: optional,
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Test-only: drop the cache after mutating process.env. */
export function resetEnvCache() {
  cached = undefined;
}
