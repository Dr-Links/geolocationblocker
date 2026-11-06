import { expect, test } from "@playwright/test";
import { PASSWORD, logIn, seed, signOut, signUp, uniqEmail } from "./helpers";

test("sign up → empty dashboard → sign out → log in", async ({ page }) => {
  const email = uniqEmail("auth");
  await signUp(page, { email, workspace: "E2E Workspace" });
  await expect(page.getByTestId("workspace-name")).toHaveText("E2E Workspace");
  await expect(page.getByTestId("empty-state")).toBeVisible();

  await signOut(page);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);

  await logIn(page, email, PASSWORD);
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
  await logIn(page, seed.adminEmail, seed.adminPassword);
  await expect(page.getByRole("link", { name: "Admin" })).toBeVisible();
  await expect(page.getByTestId("workspace-name")).toHaveText("Acme Coffee");
});
