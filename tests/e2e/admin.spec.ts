import { expect, test, type Browser } from "@playwright/test";
import { logIn, ownerDb, seed, signUp, uniqEmail } from "./helpers";

async function adminPage(browser: Browser) {
  const page = await (await browser.newContext()).newPage();
  await logIn(page, seed.adminEmail, seed.adminPassword);
  return page;
}

test("admin finds a workspace, suspends it (member locked out), then reinstates it", async ({ page, browser }) => {
  const email = uniqEmail("suspendee");
  const ws = `Suspend Co ${Date.now()}`;
  await signUp(page, { email, workspace: ws });

  const admin = await adminPage(browser);
  await admin.goto(`/admin/workspaces?q=${encodeURIComponent(email)}`);
  await admin.getByTestId("admin-workspaces").getByRole("link", { name: ws }).click();
  await expect(admin.getByRole("heading", { name: ws })).toBeVisible();
  await admin.getByLabel("Reason for suspending").fill("e2e: terms violation");
  await admin.getByRole("button", { name: "Suspend workspace" }).click();
  await expect(admin.getByTestId("suspended-badge")).toBeVisible();

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/suspended$/);

  await admin.getByRole("button", { name: "Reinstate workspace" }).click();
  await expect(admin.getByTestId("suspended-badge")).toHaveCount(0);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId("workspace-name")).toHaveText(ws);

  // Both actions are in the audit log, filterable by action.
  await admin.goto(`/admin/audit?action=admin.workspace&actor=${encodeURIComponent(seed.adminEmail)}`);
  await expect(admin.getByTestId("audit-table")).toContainText("admin.workspace.suspend");
  await expect(admin.getByTestId("audit-table")).toContainText("admin.workspace.unsuspend");
});

test("support impersonation: banner, billing locked, actions audited, exit returns to admin", async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage();
  const ws = `Imp Co ${Date.now()}`;
  await signUp(owner, { email: uniqEmail("imp-owner"), workspace: ws });
  const w = await ownerDb.workspace.findFirstOrThrow({ where: { name: ws } });

  const admin = await adminPage(browser);
  await admin.goto(`/admin/workspaces/${w.id}`);
  await admin.getByLabel("Why you need access (audit log)").fill("Ticket 42: can't schedule");
  await admin.getByRole("button", { name: "Open workspace as support" }).click();
  await expect(admin).toHaveURL(/\/dashboard$/);
  await expect(admin.getByTestId("impersonation-banner")).toContainText(ws);
  await expect(admin.getByTestId("workspace-name")).toHaveText(ws);

  await admin.goto("/dashboard/billing");
  await expect(admin.getByTestId("impersonation-readonly")).toBeVisible();
  await expect(admin.getByText("Plan changes are disabled in support mode.")).toBeVisible();
  await expect(admin.getByTestId("plan-card-pro")).toHaveCount(0);

  // A write while impersonating is attributed to the admin, via support.
  await admin.goto("/dashboard/compose");
  await admin.getByLabel("Post text").fill("Saved by support");
  await admin.getByRole("button", { name: "Save draft" }).click();
  await expect(admin.getByText(/Draft saved/)).toBeVisible();

  await admin.getByRole("button", { name: "Exit support mode" }).click();
  await expect(admin).toHaveURL(new RegExp(`/admin/workspaces/${w.id}$`));
  await admin.goto("/dashboard");
  await expect(admin.getByTestId("impersonation-banner")).toHaveCount(0);

  await admin.goto(`/admin/audit?workspaceId=${w.id}&impersonated=1`);
  await expect(admin.getByTestId("audit-table")).toContainText("admin.impersonation.start");
  await expect(admin.getByTestId("audit-table")).toContainText(`via ${seed.adminEmail}`);
});

test("admin disables a user (signed out at once), re-enables, and grants SUPER_ADMIN", async ({ page, browser }) => {
  const email = uniqEmail("disable-me");
  await signUp(page, { email });
  const u = await ownerDb.user.findUniqueOrThrow({ where: { email } });

  const admin = await adminPage(browser);
  await admin.goto(`/admin/users?q=${encodeURIComponent(email)}`);
  await admin.getByTestId("admin-users").getByRole("link", { name: email }).click();
  await expect(admin).toHaveURL(new RegExp(`/admin/users/${u.id}$`));
  await admin.getByRole("button", { name: "Disable" }).click();
  await expect(admin.getByTestId("user-disabled")).toBeVisible();

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("e2ePassword123");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/login/);

  await admin.getByRole("button", { name: "Enable" }).click();
  await expect(admin.getByTestId("user-disabled")).toHaveCount(0);
  await admin.getByRole("button", { name: "Make SUPER_ADMIN" }).click();
  await expect(admin.getByRole("button", { name: "Remove SUPER_ADMIN" })).toBeVisible();

  await logIn(page, email);
  await expect(page.getByRole("link", { name: "Admin" })).toBeVisible();
  await admin.getByRole("button", { name: "Remove SUPER_ADMIN" }).click();
  await expect(admin.getByRole("button", { name: "Make SUPER_ADMIN" })).toBeVisible();
});

test("admin overview and ops pages render charts and queue health", async ({ browser }) => {
  const admin = await adminPage(browser);
  await admin.goto("/admin");
  for (const id of ["mrr", "chart-signups", "chart-published", "chart-generations"]) await expect(admin.getByTestId(id)).toBeVisible();
  await admin.goto("/admin/ops");
  await expect(admin.getByTestId("ops-queues")).toContainText("publish");
  await expect(admin.getByTestId("ops-queues")).not.toContainText("unreachable");
});

test("user dashboard shows upcoming posts and publishing analytics", async ({ page }) => {
  await logIn(page, "demo@example.com", seed.demoPassword);
  await expect(page.getByTestId("upcoming-posts")).toBeVisible();
  await expect(page.getByTestId("ws-chart-published")).toBeVisible();
  await expect(page.getByTestId("ws-chart-generations")).toBeVisible();
});
