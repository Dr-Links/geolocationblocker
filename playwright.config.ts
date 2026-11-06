import { defineConfig, devices } from "@playwright/test";

try {
  process.loadEnvFile(".env");
} catch {
  /* CI provides env directly */
}

// Run e2e against the TEST database so local dev data stays clean (CI uses one DB for both).
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  if (process.env.TEST_DIRECT_DATABASE_URL) process.env.DIRECT_DATABASE_URL = process.env.TEST_DIRECT_DATABASE_URL;
}

const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run start -- -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Many sign-ups/logins from one IP; the limiter itself is covered by integration tests.
    env: { ...process.env, APP_URL: `http://localhost:${PORT}`, RATE_LIMIT_SIGNUP_PER_HOUR: "100000", RATE_LIMIT_LOGIN_PER_15M: "100000" } as Record<string, string>,
  },
});
