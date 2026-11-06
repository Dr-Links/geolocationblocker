import { execSync } from "node:child_process";

/** Migrate (when an owner URL is given) and seed the e2e database. playwright.config.ts already pointed DATABASE_URL at it. */
export default function globalSetup() {
  const env = { ...process.env };
  if (process.env.TEST_DIRECT_DATABASE_URL) execSync("npx prisma migrate deploy", { stdio: "ignore", env });
  execSync("npx tsx prisma/seed.ts", { stdio: "ignore", env });
}
