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
const WORKER_HEALTH_PORT = Number(process.env.E2E_WORKER_PORT ?? 3101);

// Many sign-ups/logins from one IP; the limiter itself is covered by integration tests.
// Separate Redis DB so a dev worker never steals e2e jobs (and vice versa).
const serverEnv = {
  ...process.env,
  APP_URL: `http://localhost:${PORT}`,
  REDIS_URL: process.env.E2E_REDIS_URL ?? "redis://localhost:6379/14",
  RATE_LIMIT_SIGNUP_PER_HOUR: "100000",
  RATE_LIMIT_LOGIN_PER_15M: "100000",
  RATE_LIMIT_GENERATIONS_PER_MIN: "1000",
  MOCK_AI_DELAY_MS: "200",
  MOCK_PUBLISH_DELAY_MS: "100",
  PUBLISH_RETRY_BASE_MS: "2000",
  RATE_LIMIT_SCHEDULE_PER_MIN: "1000",
  STORAGE_LOCAL_DIR: ".data/e2e-media",
} as Record<string, string>;

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  // Specs share seeded data (Acme workspace), one app server and one worker: run serially.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `npm run start -- -p ${PORT}`,
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: serverEnv,
    },
    {
      // The BullMQ worker processes AI generations (mock providers: no keys needed).
      command: "npm run worker",
      url: `http://localhost:${WORKER_HEALTH_PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { ...serverEnv, WORKER_HEALTH_PORT: String(WORKER_HEALTH_PORT) },
    },
  ],
});
