import { randomBytes } from "node:crypto";

try {
  process.loadEnvFile(".env");
} catch {
  /* no .env (CI) */
}

// Integration tests use a dedicated database. TEST_DATABASE_URL must be the
// runtime (non-superuser, app_user) role so row-level security is exercised.
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ENCRYPTION_KEY ||= randomBytes(32).toString("base64");
process.env.AUTH_SECRET ||= randomBytes(32).toString("base64");
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? "silent";
process.env.APP_URL ||= "http://localhost:3000";
