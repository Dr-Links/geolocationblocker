import { expect, test } from "@playwright/test";
import { logIn, ownerDb, seed } from "./helpers";

test("pages send a nonce CSP and the app runs without CSP violations", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => { if (/Content Security Policy|Refused to/.test(m.text())) violations.push(m.text()); });
  page.on("pageerror", (e) => violations.push(e.message));

  const res = await page.goto("/login");
  const csp = res!.headers()["content-security-policy"];
  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(res!.headers()["x-frame-options"]).toBe("DENY");
  // The nonce is fresh per request.
  const csp2 = (await page.request.get("/login")).headers()["content-security-policy"];
  expect(csp2).not.toEqual(csp);

  await logIn(page, seed.adminEmail, seed.adminPassword);
  for (const path of ["/dashboard", "/dashboard/compose", "/dashboard/calendar", "/dashboard/posts", "/dashboard/accounts", "/dashboard/billing", "/admin", "/admin/audit"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  // Client-side interactivity works (hydrated React under the CSP).
  await page.goto("/dashboard/compose");
  await page.getByLabel("Post text").fill("csp check");
  await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled();
  expect(violations).toEqual([]);
});

test("unknown pages show the not-found page; unknown API ids return JSON 404", async ({ page }) => {
  await logIn(page, "demo@example.com", seed.demoPassword);
  const res = await page.goto("/definitely-not-a-page");
  expect(res!.status()).toBe(404);
  await expect(page.getByTestId("not-found")).toBeVisible();

  const api = await page.request.get("/api/generations/does-not-exist");
  expect(api.status()).toBe(404);
  expect(await api.json()).toMatchObject({ code: "NOT_FOUND" });
  expect((await page.request.get("/api/media/does-not-exist")).status()).toBe(404);
});

test("health check reports db and redis", async ({ request }) => {
  const r = await request.get("/api/health");
  expect(r.status()).toBe(200);
  expect(await r.json()).toEqual({ status: "ok", db: "ok", redis: "ok" });
});

test("composer: upload an image, attach it, save; disguised files and cross-site uploads are refused", async ({ page }) => {
  await logIn(page, "demo@example.com", seed.demoPassword);
  await page.goto("/dashboard/compose");
  await page.getByLabel("Post text").fill("Post with an uploaded photo");
  await page.getByLabel("Upload media").setInputFiles("tests/fixtures/media/img.jpg");
  await expect(page.getByTestId("attached-media").locator("img")).toHaveCount(1);

  await page.getByLabel("Upload media").setInputFiles("tests/fixtures/media/evil.svg");
  await expect(page.getByTestId("upload-error")).toContainText("Unsupported file");
  await expect(page.getByTestId("attached-media").locator("img")).toHaveCount(1);

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved.")).toBeVisible();
  await expect(page).toHaveURL(/compose\?post=/);
  await page.reload();
  await expect(page.getByTestId("attached-media").locator("img")).toHaveCount(1);

  // The stored image is served back through the tenant-checked media route.
  const src = await page.getByTestId("attached-media").locator("img").getAttribute("src");
  const media = await page.request.get(src!);
  expect([media.status(), media.headers()["content-type"]]).toEqual([200, "image/jpeg"]);

  const forged = await page.request.post("/api/media/upload", {
    headers: { origin: "https://evil.example" },
    multipart: { file: { name: "x.jpg", mimeType: "image/jpeg", buffer: Buffer.from("x") } },
  });
  expect(forged.status()).toBe(403);
});

test("another workspace's media, generations and posts are invisible through every route", async ({ page }) => {
  const globex = await ownerDb.workspace.findFirstOrThrow({ where: { name: "Globex Bakery" } });
  const media = await ownerDb.mediaAsset.create({ data: { workspaceId: globex.id, kind: "IMAGE", source: "UPLOAD", storageKey: `workspaces/${globex.id}/e2e/secret.png`, mimeType: "image/png" } });
  const gen = await ownerDb.generationRequest.create({ data: { workspaceId: globex.id, type: "TEXT", prompt: "globex secret prompt", provider: "MOCK", status: "SUCCEEDED" } });
  const post = await ownerDb.post.findFirstOrThrow({ where: { workspaceId: globex.id } });

  await logIn(page, "demo@example.com", seed.demoPassword);
  expect((await page.request.get(`/api/media/${media.id}`)).status()).toBe(404);
  const g = await page.request.get(`/api/generations/${gen.id}`);
  expect(g.status()).toBe(404);
  expect(await g.text()).not.toContain("globex secret");

  await page.goto(`/dashboard/compose?post=${post.id}`);
  await expect(page.getByText("Globex private draft")).toHaveCount(0);
  await ownerDb.generationRequest.delete({ where: { id: gen.id } });
  await ownerDb.mediaAsset.delete({ where: { id: media.id } });
});
