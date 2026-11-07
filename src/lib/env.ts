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

/**
 * Integrations that need every listed variable once any one is set. A
 * half-configured integration would otherwise fail at runtime (e.g. Stripe
 * checkout works but webhooks are rejected), so it's caught at boot instead.
 */
export const INTEGRATION_GROUPS: Record<string, string[]> = {
  "Google sign-in": ["AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"],
  "GitHub sign-in": ["AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET"],
  "S3/R2 storage": ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"],
  Stripe: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  X: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
  Meta: ["META_APP_ID", "META_APP_SECRET"],
  LinkedIn: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
  TikTok: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
  YouTube: ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"],
};

const isSet = (v: string | undefined) => !!v && v.trim() !== "";

/** Returns human-readable configuration problems (empty = fine). */
export function productionConfigProblems(env: Record<string, string | undefined> = process.env): string[] {
  const problems: string[] = [];
  const parsed = schema.safeParse(env);
  if (!parsed.success) problems.push(...parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  if (isSet(env.AUTH_SECRET) && env.AUTH_SECRET!.length < 32) problems.push("AUTH_SECRET: use at least 32 characters (openssl rand -base64 32)");
  if (isSet(env.ENCRYPTION_KEY) && Buffer.from(env.ENCRYPTION_KEY!, "base64").length !== 32) {
    problems.push("ENCRYPTION_KEY: must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  }
  for (const [name, vars] of Object.entries(INTEGRATION_GROUPS)) {
    const set = vars.filter((v) => isSet(env[v]));
    if (set.length && set.length < vars.length) {
      problems.push(`${name} is half-configured: set ${vars.filter((v) => !isSet(env[v])).join(", ")} too, or clear ${set.join(", ")} to use the mock`);
    }
  }
  if (isSet(env.STRIPE_SECRET_KEY) && !/^(sk|rk)_(test|live)_/.test(env.STRIPE_SECRET_KEY!)) problems.push("STRIPE_SECRET_KEY doesn't look like a Stripe secret key (sk_… or rk_…)");
  if (isSet(env.SEED_ADMIN_PASSWORD) && env.SEED_ADMIN_PASSWORD === "ChangeMe123!" && env.APP_URL?.startsWith("https://")) {
    problems.push("SEED_ADMIN_PASSWORD is still the example value on a public deployment");
  }
  return problems;
}

/** Called at server boot in production: fail fast with every problem listed at once. */
export function assertProductionConfig() {
  if (process.env.NODE_ENV !== "production") return;
  const problems = productionConfigProblems();
  if (problems.length) throw new Error(`Invalid production configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
}
