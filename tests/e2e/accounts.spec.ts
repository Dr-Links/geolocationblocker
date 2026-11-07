import { expect, test } from "@playwright/test";
import { logIn, ownerDb, seed, signUp, uniqEmail } from "./helpers";

test.afterAll(() => ownerDb.$disconnect());

async function connect(page: import("@playwright/test").Page, platform: string, handle: string) {
  await page.goto("/dashboard/accounts");
  await page.getByTestId(`connect-${platform}`).click();
  await expect(page).toHaveURL(/\/connect\/mock/);
  await expect(page.getByText("SIMULATED")).toBeVisible();
  await page.getByLabel(/account handle/).fill(handle);
  await page.getByRole("button", { name: "Authorize" }).click();
  await expect(page).toHaveURL(/\/dashboard\/accounts\?connected=/);
}

test("connect accounts via OAuth (mock), see health, disconnect; plan limit applies", async ({ page }) => {
  await signUp(page, { email: uniqEmail("social"), workspace: "Social Co" }); // Free: 2 accounts
  await connect(page, "X", "social_co");
  await expect(page.getByRole("status")).toContainText("Connected: social_co");
  await expect(page.getByTestId("account-X")).toContainText("@social_co");
  await expect(page.getByTestId("account-X")).toContainText("Connected");
  await expect(page.getByTestId("account-X")).toContainText("mock");

  await connect(page, "LINKEDIN", "Social Co");
  await expect(page.getByTestId("account-usage")).toContainText("2 of 2");
  // At the limit: connect tiles are disabled.
  await expect(page.getByTestId("connect-TIKTOK")).toHaveCount(0);

  await page.getByTestId("account-X").getByRole("button", { name: "Check" }).click();
  await expect(page.getByText("Connection OK.")).toBeVisible();

  await page.getByTestId("account-X").getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByTestId("account-X")).toContainText("Disconnected");
  await expect(page.getByTestId("account-usage")).toContainText("1 of 2");
});

test("cancelling consent returns with a message and connects nothing", async ({ page }) => {
  await signUp(page, { email: uniqEmail("cancel"), workspace: "Cancel Co" });
  await page.goto("/dashboard/accounts");
  await page.getByTestId("connect-YOUTUBE").click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "cancelled" })).toContainText("Connection was cancelled.");
  await expect(page.getByTestId("accounts-list")).not.toContainText("YouTube");
});

test("a replayed/forged callback is rejected", async ({ page }) => {
  await signUp(page, { email: uniqEmail("forge"), workspace: "Forge Co" });
  await page.goto("/api/social/callback/x?code=whatever&state=forged");
  await expect(page).toHaveURL(/\/dashboard\/accounts\?error=/);
  await expect(page.getByRole("alert").filter({ hasText: /invalid or expired/ })).toBeVisible();
});

test("validate a draft against connected accounts in the composer (live previews)", async ({ page }) => {
  await logIn(page, "demo@example.com", seed.demoPassword); // Acme: seeded mock X, Instagram, LinkedIn
  await page.goto("/dashboard/compose");
  await page.getByLabel("Post text").fill("A".repeat(300));
  const targets = page.getByTestId("target-accounts");
  for (const p of ["X", "Instagram", "LinkedIn"]) await targets.getByText(new RegExp(`^${p} · `)).click();

  await expect(page.getByTestId("preview-X")).toContainText("X allows 280 characters");
  await expect(page.getByTestId("preview-INSTAGRAM")).toContainText("need at least one image or video");
  await expect(page.getByTestId("preview-LINKEDIN")).toContainText("Ready for LinkedIn");

  await page.getByLabel("Post text").fill("Short post for X");
  await expect(page.getByTestId("preview-X")).toContainText("Ready for X");
});

test("members can view accounts but not connect", async ({ page }) => {
  // Seeded Acme has demo (admin) + admin; use a fresh member via the DB for brevity.
  const email = uniqEmail("viewer");
  await signUp(page, { email, workspace: "Viewer Own" });
  const acme = await ownerDb.workspace.findUniqueOrThrow({ where: { slug: "acme-coffee" } });
  const user = await ownerDb.user.findUniqueOrThrow({ where: { email } });
  await ownerDb.membership.create({ data: { userId: user.id, workspaceId: acme.id, role: "MEMBER" } });
  await page.goto("/dashboard");
  await page.getByTestId("workspace-switcher").selectOption({ label: "Acme Coffee" });
  await expect(page.getByTestId("workspace-name")).toHaveText("Acme Coffee");
  await page.goto("/dashboard/accounts");
  await expect(page.getByTestId("accounts-list")).toContainText("@acmecoffee");
  await expect(page.getByText("Connect a platform")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Disconnect" })).toHaveCount(0);
});
