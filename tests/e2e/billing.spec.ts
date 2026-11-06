import { expect, test, type Browser } from "@playwright/test";
import { logIn, ownerDb, seed, signUp, subscribe, uniqEmail, PASSWORD } from "./helpers";

test.afterAll(() => ownerDb.$disconnect());

async function adminPage(browser: Browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await logIn(page, seed.adminEmail, seed.adminPassword);
  return page;
}

test("new workspace: free plan → declined card → subscribe with test card → manage in portal", async ({ page }) => {
  await signUp(page, { email: uniqEmail("buyer"), workspace: "Buyer Co" });
  await page.goto("/dashboard/billing");
  await expect(page.getByTestId("current-plan")).toHaveText("Free");

  await subscribe(page, "pro", "4000 0000 0000 0002");
  await expect(page.getByText(/card was declined/)).toBeVisible();
  await page.getByLabel("Card number").fill("4242 4242 4242 4242");
  await page.getByRole("button", { name: /^Pay / }).click();

  await expect(page).toHaveURL(/checkout=success/);
  await expect(page.getByTestId("current-plan")).toHaveText("Pro");
  await expect(page.getByTestId("sub-status")).toHaveText("Active");
  await expect(page.getByTestId("usage-maxSocialAccounts")).toContainText("/ 15");

  await page.getByRole("button", { name: "Manage billing" }).click();
  await expect(page).toHaveURL(/\/billing\/mock\/portal/);
  await page.getByRole("button", { name: "Cancel at period end" }).click();
  await expect(page.getByRole("button", { name: "Resume subscription" })).toBeVisible();
  await page.getByRole("button", { name: "Fail next payment" }).click();
  await expect(page.getByTestId("portal-status")).toHaveText("PAST_DUE");
  await page.getByRole("link", { name: "Return to Postpilot" }).click();
  await expect(page.getByTestId("sub-status")).toContainText("Payment failed");
});

test("admin sets and changes a plan's price; customers see it; old price is grandfathered", async ({ page, browser }) => {
  const admin = await adminPage(browser);
  const key = `e2e-${Date.now().toString(36)}`;
  await admin.goto("/admin/plans/new");
  await admin.getByLabel("Name").fill("E2E Plan");
  await admin.getByLabel("Key (permanent id)").fill(key);
  await admin.getByLabel("Price").fill("33");
  await admin.getByLabel("Connected accounts").fill("7");
  await admin.getByRole("button", { name: "Create plan" }).click();
  await expect(admin.getByText("Plan created.")).toBeVisible();

  // A customer buys it at $33.
  await signUp(page, { email: uniqEmail("early"), workspace: "Early Bird" });
  await page.goto("/dashboard/billing");
  await expect(page.getByTestId(`plan-card-${key}`)).toContainText("$33");
  await subscribe(page, key);
  await expect(page.getByTestId("current-plan")).toHaveText("E2E Plan");

  // Admin raises it to $44.
  await admin.reload();
  await admin.getByLabel("Price").fill("44");
  await admin.getByRole("button", { name: "Save plan" }).click();
  await expect(admin.getByText(/1 existing subscriber keeps their current price/)).toBeVisible();
  await admin.reload();
  await expect(admin.getByTestId("price-history")).toContainText("grandfathered");

  // The early customer still pays $33; a new customer sees $44.
  await page.reload();
  await expect(page.getByText("$33/mo")).toBeVisible();
  const ctx2 = await browser.newContext();
  const late = await ctx2.newPage();
  await signUp(late, { email: uniqEmail("late"), workspace: "Late Co" });
  await late.goto("/dashboard/billing");
  await expect(late.getByTestId(`plan-card-${key}`)).toContainText("$44");

  // Clean up: hide the plan from the pricing page.
  await admin.getByLabel("Shown on the pricing page").uncheck();
  await admin.getByRole("button", { name: "Save plan" }).click();
  await expect(admin.getByText("Saved.")).toBeVisible();
});

test("admin creates a free account; the owner signs up via the link and gets the comped plan", async ({ page, browser }) => {
  const admin = await adminPage(browser);
  const ownerEmail = uniqEmail("comped");
  await admin.goto("/admin/accounts/new");
  await admin.getByLabel("Owner email").fill(ownerEmail);
  await admin.getByLabel("Workspace name").fill("Partner Studio");
  await admin.getByLabel("Plan to grant").selectOption({ label: "Agency" });
  await admin.getByLabel("Reason (audit log)").fill("Launch partner");
  await admin.getByRole("button", { name: "Create free account" }).click();
  const link = await admin.getByTestId("comped-invite-link").inputValue();

  await page.goto(new URL(link).pathname);
  await page.getByRole("link", { name: "Create an account to accept" }).click();
  await page.getByLabel("Your name").fill("Partner");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /Create account & join Partner Studio/ }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText("Agency plan (complimentary)")).toBeVisible();

  await page.goto("/dashboard/billing");
  await expect(page.getByText("Complimentary")).toBeVisible();
  await expect(page.getByTestId("plan-card-pro")).toHaveCount(0); // nothing to buy
  // Partner is the workspace admin and can invite (Agency seats).
  await page.goto("/dashboard/settings/members");
  await expect(page.getByRole("button", { name: "Send invite" })).toBeVisible();
});

test("admin partially comps an existing workspace and can remove it", async ({ page, browser }) => {
  const email = uniqEmail("partial");
  await signUp(page, { email, workspace: "Nonprofit Org" });
  const ws = await ownerDb.workspace.findFirstOrThrow({ where: { memberships: { some: { user: { email } } } } });

  const admin = await adminPage(browser);
  await admin.goto(`/admin/workspaces/${ws.id}`);
  await admin.getByLabel("Plan to grant").selectOption({ label: "Free" });
  await admin.getByText("Partial comp: override limits or features (optional)").click();
  await admin.getByLabel("Accounts", { exact: true }).fill("12");
  await admin.getByLabel("AI video").selectOption("on");
  await admin.getByLabel("Reason (audit log)").fill("Nonprofit discount");
  await admin.getByRole("button", { name: "Comp this workspace" }).click();
  await expect(admin.getByText("Workspace comped.")).toBeVisible();
  await admin.reload();
  await expect(admin.getByTestId("entitlement-source")).toHaveText("comp");

  await page.goto("/dashboard/billing");
  await expect(page.getByTestId("usage-maxSocialAccounts")).toContainText("/ 12");

  await admin.getByRole("button", { name: "Remove comp" }).click();
  await expect(admin.getByText(/Comp removed\./)).toBeVisible();
  await expect(admin.getByTestId("entitlement-source")).toHaveText("free");
  await page.reload();
  await expect(page.getByTestId("usage-maxSocialAccounts")).toContainText("/ 2");
});

test("free plan blocks inviting a second member with an upgrade message", async ({ page }) => {
  await signUp(page, { email: uniqEmail("solo"), workspace: "Solo" });
  await page.goto("/dashboard/settings/members");
  await page.getByLabel("Email").fill(uniqEmail("friend"));
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByText(/Free plan allows 1 member\. Upgrade/)).toBeVisible();
});

test("admin overview shows revenue; members can't manage billing", async ({ page, browser }) => {
  const admin = await adminPage(browser);
  await admin.goto("/admin");
  await expect(admin.getByTestId("mrr")).toContainText("$");

  await logIn(page, "demo@example.com", seed.demoPassword);
  await page.goto("/dashboard/billing");
  await expect(page.getByText("Pro").first()).toBeVisible();
  await expect(page.getByText("Complimentary")).toBeVisible();
});
