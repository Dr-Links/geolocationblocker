import { expect, test } from "@playwright/test";
import { logIn, ownerDb, seed, signOut, signUp, subscribe, uniqEmail, PASSWORD } from "./helpers";

test.afterAll(() => ownerDb.$disconnect());

test("seeded demo user sees only their own tenant", async ({ page }) => {
  await logIn(page, "demo@example.com", seed.demoPassword);
  await expect(page.getByTestId("workspace-name")).toHaveText("Acme Coffee");
  await expect(page.getByTestId("stat-scheduled")).toHaveText("3");
  const options = await page.getByTestId("workspace-switcher").locator("option").allTextContents();
  expect(options).toEqual(["Acme Coffee"]);
});

test("a forged active-workspace cookie cannot open another tenant", async ({ page, context, baseURL }) => {
  const globex = await ownerDb.workspace.findUniqueOrThrow({ where: { slug: "globex-bakery" } });
  await logIn(page, "demo@example.com", seed.demoPassword);
  await context.addCookies([{ name: "pp_ws", value: globex.id, url: baseURL! }]);
  await page.goto("/dashboard");
  await expect(page.getByTestId("workspace-name")).toHaveText("Acme Coffee");
  await expect(page.getByText("Globex")).toHaveCount(0);
  await page.goto("/dashboard/settings");
  await expect(page.getByLabel("Workspace name")).toHaveValue("Acme Coffee");
});

test("non-admins are kept out of /admin; super admin gets in", async ({ page }) => {
  await logIn(page, "demo@example.com", seed.demoPassword);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/dashboard$/);
  await signOut(page);

  await logIn(page, seed.adminEmail, seed.adminPassword);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Platform overview" })).toBeVisible();
  await expect(page.getByTestId("admin-workspaces")).toContainText("Globex Bakery");
  await expect(page.getByTestId("admin-workspaces")).toContainText("Acme Coffee");
});

test("signed-out visitors are redirected away from /admin", async ({ page }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login/);
});

test("invite flow: admin invites → invitee signs up via link → joins as member with limited rights", async ({ page }) => {
  const ownerEmail = uniqEmail("owner");
  const inviteeEmail = uniqEmail("invitee");
  const wsName = `Team ${Date.now()}`;

  await signUp(page, { email: ownerEmail, name: "Owner", workspace: wsName });
  // Free is single-seat: upgrade to Starter (2 seats) before inviting.
  await subscribe(page, "starter");
  await expect(page).toHaveURL(/checkout=success/);
  await page.goto("/dashboard/settings/members");
  await page.getByLabel("Email").fill(inviteeEmail);
  await page.getByRole("button", { name: "Send invite" }).click();
  const link = await page.getByTestId("invite-link").inputValue();
  expect(link).toContain("/invite/");
  await expect(page.getByText("Pending invitations")).toBeVisible();
  await signOut(page);

  await page.goto(new URL(link).pathname);
  await expect(page.getByText(`Join ${wsName}`, { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Create an account to accept" }).click();
  await expect(page.getByLabel("Email")).toHaveValue(inviteeEmail);
  await expect(page.getByLabel("Workspace name")).toHaveCount(0);
  await page.getByLabel("Your name").fill("Invitee");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: `Create account & join ${wsName}` }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId("workspace-name")).toHaveText(wsName);

  // Member can see the team but not manage it.
  await page.goto("/dashboard/settings/members");
  await expect(page.getByTestId("members-table")).toContainText(ownerEmail);
  await expect(page.getByRole("button", { name: "Send invite" })).toHaveCount(0);
  await page.goto("/dashboard/settings");
  await expect(page.getByLabel("Workspace name")).toBeDisabled();

  // The used link is dead.
  await page.goto(new URL(link).pathname);
  await expect(page.getByText("Invitation unavailable")).toBeVisible();
});

test("create a second workspace and switch between them", async ({ page }) => {
  await signUp(page, { email: uniqEmail("multi"), workspace: "First WS" });
  await page.goto("/dashboard/workspaces/new");
  await page.getByLabel("Workspace name").fill("Second WS");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId("workspace-name")).toHaveText("Second WS");

  await page.getByTestId("workspace-switcher").selectOption({ label: "First WS" });
  await expect(page.getByTestId("workspace-name")).toHaveText("First WS");
});

test("admin can rename the workspace", async ({ page }) => {
  await signUp(page, { email: uniqEmail("rename"), workspace: "Old Name" });
  await page.goto("/dashboard/settings");
  await page.getByLabel("Workspace name").fill("New Name");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByTestId("workspace-name")).toHaveText("New Name");
});

test("revoking sessions (sessionVersion bump) or disabling a user ends their live session", async ({ page }) => {
  const email = uniqEmail("revoke");
  await signUp(page, { email });
  await ownerDb.user.update({ where: { email }, data: { sessionVersion: { increment: 1 } } });
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);

  const email2 = uniqEmail("disable");
  await signUp(page, { email: email2 });
  await ownerDb.user.update({ where: { email: email2 }, data: { disabledAt: new Date() } });
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
});
