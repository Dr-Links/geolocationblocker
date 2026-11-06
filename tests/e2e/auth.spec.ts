import { expect, test } from "@playwright/test";

const password = "e2ePassword123";

test("sign up → empty dashboard → sign out → log in", async ({ page }) => {
  const email = `e2e-${Date.now()}@e2e.local`;

  await page.goto("/signup");
  await page.getByLabel("Your name").fill("E2E User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByLabel("Workspace name").fill("E2E Workspace");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId("workspace-name")).toHaveText("E2E Workspace");
  await expect(page.getByTestId("empty-state")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);

  // Protected route redirects when signed out.
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId("user-email")).toHaveText(email);
});

test("bad credentials show an error", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("nobody@e2e.local");
  await page.getByLabel("Password").fill("whatever123");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("Invalid email or password")).toBeVisible();
});

test("validation errors on sign up", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("X");
  await page.getByLabel("Email").fill("not-an-email");
  await page.getByLabel("Password").fill("short");
  await page.getByLabel("Workspace name").fill("WS");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Enter a valid email")).toBeVisible();
  await expect(page.getByText("Password must be at least 10 characters")).toBeVisible();
});

test("seeded super admin can log in and sees the seeded workspace", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.SEED_ADMIN_EMAIL ?? "admin@example.com");
  await page.getByLabel("Password").fill(process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText("Admin", { exact: true })).toBeVisible();
  await expect(page.getByTestId("workspace-name")).toHaveText("Acme Coffee");
});
