import { expect, test, type Page } from "@playwright/test";
import { logIn, ownerDb, seed, signUp, uniqEmail } from "./helpers";

test.afterAll(() => ownerDb.$disconnect());

async function generate(page: Page, tab: "Caption" | "Image" | "Video", prompt: string) {
  await page.getByRole("tab", { name: tab }).click();
  await page.getByLabel(/^(Brief|Describe the)/).fill(prompt);
  await page.getByRole("button", { name: /^Generate · / }).click();
  await expect(page.getByTestId("generation-result").or(page.getByTestId("generation-error"))).toBeVisible({ timeout: 30_000 });
}

test("compose: generate caption, image and video (mock), attach, save draft", async ({ page }) => {
  await logIn(page, "demo@example.com", seed.demoPassword); // Acme Coffee: comped Pro (video enabled)
  await page.goto("/dashboard/compose");

  await page.locator("#gen-platform").selectOption("X");
  await generate(page, "Caption", "Announce our pumpkin cold brew launch this Friday");
  await expect(page.getByTestId("generation-meta")).toContainText("Mock provider");
  await expect(page.getByTestId("generation-meta")).toContainText("1 credit");
  await page.getByTestId("generation-result").getByRole("button", { name: "Use" }).first().click();
  await expect(page.getByLabel("Post text")).toHaveValue(/pumpkin cold brew/i);

  await generate(page, "Image", "Pumpkin cold brew on a rustic wooden table");
  const img = page.getByTestId("generation-result").locator("img");
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0); // served by /api/media
  await page.getByRole("button", { name: "Attach to post" }).click();

  await generate(page, "Video", "Slow pour of cold brew over ice");
  await expect(page.getByTestId("generation-result").locator("video")).toBeVisible();
  await page.getByRole("button", { name: "Attach to post" }).click();
  await expect(page.getByTestId("attached-media").locator("img, video")).toHaveCount(2);

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page).toHaveURL(/\/dashboard\/compose\?post=/);
  await page.reload();
  await expect(page.getByLabel("Post text")).toHaveValue(/pumpkin cold brew/i);
  await expect(page.getByTestId("attached-media").locator("img, video")).toHaveCount(2);
  await expect(page.getByTestId("drafts-list")).toContainText(/pumpkin cold brew/i);
});

test("free plan: video is locked; credits decrease; failures refund", async ({ page }) => {
  await signUp(page, { email: uniqEmail("aifree"), workspace: "AI Free" });
  await page.goto("/dashboard/compose");
  await expect(page.getByTestId("credits-left")).toHaveText("20 credits left");

  await page.getByRole("tab", { name: "Video" }).click();
  await expect(page.getByTestId("video-locked")).toBeVisible();

  await generate(page, "Image", "A cozy cafe interior");
  await expect(page.getByTestId("credits-left")).toHaveText("15 credits left");

  // Simulated provider outage → error shown, credits refunded.
  await generate(page, "Caption", "This will fail [mock:fail]");
  await expect(page.getByTestId("generation-error")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("credits-left")).toHaveText("15 credits left");
});

test("media of one workspace is not reachable from another", async ({ page, browser }) => {
  await logIn(page, "demo@example.com", seed.demoPassword);
  await page.goto("/dashboard/compose");
  await generate(page, "Image", "Private product shot");
  const src = await page.getByTestId("generation-result").locator("img").getAttribute("src");
  expect(src).toMatch(/^\/api\/media\//);
  expect((await page.request.get(src!)).status()).toBe(200);

  const other = await (await browser.newContext()).newPage();
  await logIn(other, "other@example.com", seed.demoPassword); // Globex Bakery
  expect((await other.request.get(src!)).status()).toBe(404);
});

test("admin changes credit costs; composer reflects it", async ({ page, browser }) => {
  const admin = await (await browser.newContext()).newPage();
  await logIn(admin, seed.adminEmail, seed.adminPassword);
  await admin.goto("/admin/ai");
  await expect(admin.getByTestId("platform-keys")).toContainText("not configured");
  await admin.getByLabel("Text / caption").fill("2");
  await admin.getByRole("button", { name: "Save costs" }).click();
  await expect(admin.getByText("Credit costs saved")).toBeVisible();

  await logIn(page, "demo@example.com", seed.demoPassword);
  await page.goto("/dashboard/compose");
  await expect(page.getByRole("button", { name: "Generate · 2 credits" })).toBeVisible();

  await admin.getByLabel("Text / caption").fill("1");
  await admin.getByRole("button", { name: "Save costs" }).click();
  await expect(admin.getByText("Credit costs saved")).toBeVisible();
});

test("AI settings: defaults and BYOK keys (masked) on a plan that allows it", async ({ page }) => {
  await logIn(page, "demo@example.com", seed.demoPassword);
  await page.goto("/dashboard/settings/ai");
  await page.getByLabel("Provider", { exact: true }).first().selectOption("MOCK");
  await page.getByRole("button", { name: "Save defaults" }).click();
  await expect(page.getByText("Defaults saved.")).toBeVisible();

  await page.getByLabel("API key").fill("hf_e2e_test_key_abcd");
  await page.locator("#byok-provider").selectOption("HUGGINGFACE");
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByTestId("byok-keys")).toContainText("••••abcd");
  await expect(page.locator("body")).not.toContainText("hf_e2e_test_key");
  await page.getByTestId("byok-keys").getByRole("button", { name: "Remove" }).click();
  // The key row (and its form) disappears: that is the confirmation.
  await expect(page.getByText("••••abcd")).toHaveCount(0);
});

test("free plan can't add its own keys", async ({ page }) => {
  await signUp(page, { email: uniqEmail("nobyok"), workspace: "No BYOK" });
  await page.goto("/dashboard/settings/ai");
  await expect(page.getByText(/doesn't include bring-your-own-key/)).toBeVisible();
});
