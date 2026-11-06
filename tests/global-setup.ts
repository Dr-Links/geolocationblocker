import { execSync } from "node:child_process";

/**
 * Load .env (without overriding real env), then migrate the test database
 * with the owner role, if TEST_DIRECT_DATABASE_URL is provided.
 */
export default function setup() {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* no .env (CI) */
  }
  const direct = process.env.TEST_DIRECT_DATABASE_URL;
  if (direct) {
    execSync("npx prisma migrate deploy", {
      stdio: "ignore",
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL ?? direct, DIRECT_DATABASE_URL: direct },
    });
  }
}
