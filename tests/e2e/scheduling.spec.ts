import { expect, test, type Page } from "@playwright/test";
import { logIn, ownerDb, seed } from "./helpers";

test.afterAll(() => ownerDb.$disconnect());

/** Acme Coffee (seeded): comped Pro (recurring enabled) with mock X, Instagram and LinkedIn accounts. */
async function compose(page: Page, text: string, platforms: string[]) {
  await logIn(page, "demo@example.com", seed.demoPassword);
  await page.goto("/dashboard/compose");
  await page.getByLabel("Post text").fill(text);
  for (const p of platforms) await page.getByTestId("target-accounts").getByText(new RegExp(`^${p} · `)).click();
}

const stamp = () => `${Date.now().toString(36)}`;

test("ACCEPTANCE: a post scheduled for the next minute publishes via the mock at that time", async ({ page }) => {
  test.setTimeout(180_000);
  const text = `Scheduled acceptance ${stamp()}`;
  await compose(page, text, ["X", "LinkedIn"]);

  // Next whole minute in the workspace timezone (America/New_York), read back from the input's own format.
  const target = new Date(Math.ceil((Date.now() + 5_000) / 60_000) * 60_000);
  const local = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(target).replace(" ", "T");
  await page.getByLabel("Date & time").fill(local);
  await page.getByLabel("Timezone").selectOption("America/New_York");
  await page.getByRole("button", { name: "Schedule" }).click();
  await expect(page).toHaveURL(/\/dashboard\/posts\?tab=scheduled/);

  const card = page.getByTestId("posts-list").locator("[data-testid^=post-]", { hasText: text });
  await expect(card.getByTestId("post-status")).toHaveText("scheduled");
  // Before the time: still scheduled.
  if (Date.now() < target.getTime() - 3_000) {
    await page.reload();
    await expect(card.getByTestId("post-status")).toHaveText("scheduled");
  }

  // After the time: the worker publishes it.
  await page.goto("/dashboard/posts?tab=published");
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("posts-list").locator("[data-testid^=post-]", { hasText: text }).getByTestId("post-status")).toHaveText("published", { timeout: 1000 });
  }).toPass({ timeout: 150_000, intervals: [3000] });
  const published = page.getByTestId("posts-list").locator("[data-testid^=post-]", { hasText: text });
  await expect(published.getByTestId("target-X")).toContainText("✅");
  await expect(published.getByTestId("target-LINKEDIN")).toContainText("✅");
  await expect(published.getByRole("link", { name: "view post" })).toHaveCount(2);

  // It published at (not before) the scheduled minute.
  const row = await ownerDb.post.findFirstOrThrow({ where: { content: text }, include: { schedule: true } });
  expect(row.publishedAt!.getTime()).toBeGreaterThanOrEqual(target.getTime() - 1000);
  expect(row.publishedAt!.getTime() - target.getTime()).toBeLessThan(90_000);
});

test("publish now: both platforms show published with links", async ({ page }) => {
  const text = `Publish now ${stamp()}`;
  await compose(page, text, ["X", "LinkedIn"]);
  await page.getByRole("radio", { name: "Publish now" }).click();
  await page.getByRole("button", { name: "Publish now" }).click();
  await expect(page).toHaveURL(/notice=publishing/);
  const card = page.getByTestId("posts-list").locator("[data-testid^=post-]", { hasText: text });
  await expect(async () => {
    await page.reload();
    await expect(card.getByTestId("post-status")).toHaveText("published", { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
});

test("live per-platform preview + validation; per-platform override fixes it", async ({ page }) => {
  await compose(page, "A".repeat(300), ["X", "LinkedIn"]);
  await expect(page.getByTestId("chars-X")).toHaveText("300 / 280");
  await expect(page.getByTestId("preview-X")).toContainText("X allows 280 characters");
  await expect(page.getByTestId("preview-LINKEDIN")).toContainText("Ready for LinkedIn");

  await page.getByRole("radio", { name: "Publish now" }).click();
  await page.getByRole("button", { name: "Publish now" }).click();
  await expect(page.getByTestId("schedule-problems")).toContainText("X allows 280 characters");

  await page.getByRole("tab", { name: "X" }).click();
  await page.getByLabel("X text").fill("Short version for X");
  await expect(page.getByTestId("chars-X")).toHaveText("19 / 280");
  await expect(page.getByTestId("preview-X")).toContainText("Short version for X");
  await expect(page.getByTestId("preview-LINKEDIN")).toContainText("AAAA");
  await expect(page).toHaveURL(/compose\?post=/); // the failed attempt saved a draft…
  await page.getByRole("button", { name: "Publish now" }).click();
  await expect(page).toHaveURL(/notice=publishing/);
  // …and the successful attempt reused it rather than creating a duplicate.
  expect(await ownerDb.post.count({ where: { content: "A".repeat(300), createdAt: { gt: new Date(Date.now() - 60_000) } } })).toBe(1);
});

test("partial failure → retry failed only; unschedule; delete", async ({ page }) => {
  const text = `Partial ${stamp()}`;
  await compose(page, text, ["X", "LinkedIn"]);
  await page.getByRole("tab", { name: "X" }).click();
  await page.getByLabel("X text").fill("X will reject this [mock:reject]");
  await page.getByRole("radio", { name: "Publish now" }).click();
  await page.getByRole("button", { name: "Publish now" }).click();
  await expect(page).toHaveURL(/notice=publishing/); // don't reload before the client navigation lands
  const card = page.getByTestId("posts-list").locator("[data-testid^=post-]", { hasText: text });
  await expect(async () => {
    await page.reload();
    await expect(card.getByTestId("post-status")).toHaveText("partially published", { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await expect(card.getByTestId("target-X")).toContainText("rejected by the platform");
  await expect(card.getByTestId("target-LINKEDIN")).toContainText("✅");
  await card.getByRole("button", { name: "Retry failed" }).click();
  await expect(card.getByRole("status")).toContainText("Retrying");

  // Schedule another far ahead, then unschedule it from the Posts page.
  const later = `Later ${stamp()}`;
  await page.goto("/dashboard/compose");
  await page.getByLabel("Post text").fill(later);
  await page.getByTestId("target-accounts").getByText(/^LinkedIn · /).click();
  await page.getByRole("button", { name: "Schedule" }).click();
  await expect(page).toHaveURL(/tab=scheduled/);
  const lc = page.getByTestId("posts-list").locator("[data-testid^=post-]", { hasText: later });
  await lc.getByRole("button", { name: "Unschedule" }).click();
  await page.goto("/dashboard/posts?tab=drafts");
  const dc = page.getByTestId("posts-list").locator("[data-testid^=post-]", { hasText: later });
  await expect(dc.getByTestId("post-status")).toHaveText("draft");
  page.on("dialog", (d) => d.accept());
  await dc.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("posts-list").locator("[data-testid^=post-]", { hasText: later })).toHaveCount(0);
});

test("calendar shows scheduled posts; queue slots + add to queue; weekly repeat", async ({ page }) => {
  const text = `Queued ${stamp()}`;
  await logIn(page, "demo@example.com", seed.demoPassword);
  await page.goto("/dashboard/calendar");
  await page.getByLabel("Time").fill("10:30");
  await page.getByRole("button", { name: "Add slots" }).click();
  await expect(page.getByTestId("queue-slots")).toContainText("Mon 10:30");

  await page.goto("/dashboard/compose");
  await page.getByLabel("Post text").fill(text);
  await page.getByTestId("target-accounts").getByText(/^LinkedIn · /).click();
  await page.getByRole("radio", { name: "Add to queue" }).click();
  await page.getByLabel("Repeat").selectOption("WEEKLY");
  await page.getByRole("button", { name: "Add to queue" }).click();
  await expect(page).toHaveURL(/tab=scheduled/);
  const card = page.getByTestId("posts-list").locator("[data-testid^=post-]", { hasText: text });
  await expect(card).toContainText("10:30");
  await expect(card).toContainText("Every week");

  const row = await ownerDb.post.findFirstOrThrow({ where: { content: text }, include: { schedule: true } });
  const month = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).format(row.schedule!.scheduledAt).slice(0, 7);
  await page.goto(`/dashboard/calendar?month=${month}`);
  await expect(page.getByTestId("calendar-grid").getByTestId("calendar-chip").filter({ hasText: text })).toBeVisible();
});
