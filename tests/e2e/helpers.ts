import { expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

export const PASSWORD = "e2ePassword123";
export const uniqEmail = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.local`;

/** Owner-role client for test setup/inspection only (bypasses RLS as table owner/superuser). */
export const ownerDb = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL });

export async function signUp(page: Page, opts: { email: string; name?: string; workspace?: string }) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(opts.name ?? "E2E User");
  await page.getByLabel("Email").fill(opts.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Workspace name").fill(opts.workspace ?? "E2E Workspace");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

export async function logIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

export async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  // The sign-out response must have cleared the session cookie before we continue.
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
  await expect.poll(async () => (await page.context().cookies()).some((c) => c.name.includes("authjs.session-token"))).toBe(false);
}

export const seed = {
  adminEmail: process.env.SEED_ADMIN_EMAIL ?? "admin@example.com",
  adminPassword: process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!",
  demoPassword: process.env.SEED_DEMO_PASSWORD ?? "Demo12345!",
};

/** Subscribe the active workspace to a plan through the (mock) checkout. */
export async function subscribe(page: Page, planKey: string, card = "4242 4242 4242 4242") {
  await page.goto("/dashboard/billing");
  await page.getByTestId(`plan-card-${planKey}`).getByRole("button").click();
  await expect(page).toHaveURL(/\/billing\/mock\/checkout/);
  await page.getByLabel("Card number").fill(card);
  await page.getByRole("button", { name: /^Pay / }).click();
}
