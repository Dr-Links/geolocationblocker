import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, systemDb, tenantDb } from "@/lib/db";
import { getQueue, QUEUES } from "@/lib/queues";
import { compWorkspace } from "@/server/billing/comp";
import { chargeGeneration, getEntitlements, getUsage, refundGeneration } from "@/server/billing/entitlements";
import { ContentRefusedError, ProviderError } from "@/server/ai/errors";
import { getPlatformKey, removePlatformKey, setPlatformKey, setWorkspaceKey } from "@/server/ai/credentials";
import { updatePreferences } from "@/server/ai/preferences";
import { overrideGenerator } from "@/server/ai/registry";
import { getGeneration, processGeneration, requestGeneration } from "@/server/ai/service";
import type { CallContext, TextGenerator } from "@/server/ai/types";
import { ConflictError, LimitExceededError, NotFoundError } from "@/server/errors";
import { setCreditCosts } from "@/server/settings";
import { LocalStorage, getStorage, setStorageForTests } from "@/server/storage";
import { cleanupTestData, ctxFor, makeTenant, testEmail } from "./fixtures";

process.env.MOCK_AI_DELAY_MS = "0";
const ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_AI_API_KEY", "HUGGINGFACE_API_TOKEN", "AI_FALLBACK_TO_MOCK"];

let storageDir: string;
let adminId: string;


/** A fake "real" provider: records the key it was called with. */
function fakeText(provider: "OPENAI" | "GOOGLE", behavior: "ok" | "fail" | "refuse") {
  const calls: CallContext[] = [];
  const gen: TextGenerator = {
    provider,
    type: "TEXT",
    async generate(_p, _o, c) {
      calls.push(c);
      if (behavior === "fail") throw new ProviderError(`${provider} down`, provider, { retryable: true, status: 503 });
      if (behavior === "refuse") throw new ContentRefusedError(provider);
      return { kind: "text", variants: [`from ${provider}`] };
    },
  };
  overrideGenerator(provider, "TEXT", gen);
  return calls;
}

async function netCredits(workspaceId: string) {
  const ent = await getEntitlements(systemDb as never, workspaceId);
  return (await getUsage(systemDb as never, workspaceId, ent)).creditsUsed;
}

async function compedTenant(label: string, planKey = "pro") {
  const t = await makeTenant(label);
  const plan = await systemDb.plan.findUniqueOrThrow({ where: { key: planKey } });
  await compWorkspace(adminId, t.workspace.id, { planId: plan.id, reason: "ai tests" });
  return { ...t, ctx: ctxFor(t.admin.id, t.workspace.id, "WORKSPACE_ADMIN") };
}

async function run(ctx: ReturnType<typeof ctxFor>, input: Parameters<typeof requestGeneration>[1]) {
  const req = await requestGeneration(ctx, input);
  return processGeneration(req.id);
}

beforeAll(async () => {
  storageDir = mkdtempSync(path.join(tmpdir(), "pp-media-"));
  setStorageForTests(new LocalStorage(storageDir));
  await cleanupTestData();
  adminId = (await systemDb.user.create({ data: { email: testEmail("ai-admin"), platformRole: "SUPER_ADMIN" } })).id;
  // Plans may be missing in a fresh test DB.
  for (const [key, priceCents, video, byok] of [["free", 0, false, false], ["pro", 4900, true, true]] as const) {
    await systemDb.plan.upsert({
      where: { key },
      update: {},
      create: { key, name: key, priceCents, maxPostsPerMonth: 100, monthlyCredits: key === "free" ? 20 : 1000, maxSocialAccounts: 5, maxMembers: 5, features: { video, byok } },
    });
  }

  await systemDb.platformSetting.deleteMany({ where: { key: "ai.creditCosts" } });
});
beforeEach(() => ENV.forEach((k) => delete process.env[k]));
afterEach(() => {
  overrideGenerator("OPENAI", "TEXT", undefined);
  overrideGenerator("GOOGLE", "TEXT", undefined);
  ENV.forEach((k) => delete process.env[k]);
});
afterAll(async () => {
  await systemDb.providerCredential.deleteMany({ where: { workspaceId: null } });
  await systemDb.platformSetting.deleteMany({ where: { key: "ai.creditCosts" } });
  await getQueue(QUEUES.generation).obliterate({ force: true });
  await getQueue(QUEUES.generation).close();
  await cleanupTestData();
  rmSync(storageDir, { recursive: true, force: true });
  await db.$disconnect();
});

describe("mock pipeline (no keys)", () => {
  it("TEXT: queued → worker → variants; charges the default 1 credit", async () => {
    const T = await compedTenant("ai-text");
    const req = await requestGeneration(T.ctx, { type: "TEXT", prompt: "Announce our autumn menu", options: { variants: 2, platform: "X" } });
    expect(req).toMatchObject({ status: "QUEUED", provider: "MOCK" });
    expect(await getQueue(QUEUES.generation).getJob(req.id)).toBeTruthy();

    const done = await processGeneration(req.id);
    expect(done.status).toBe("SUCCEEDED");
    expect((done.output as { variants: string[] }).variants).toHaveLength(2);
    expect(done.creditsCharged).toBe(1);
    expect(await netCredits(T.workspace.id)).toBe(1);
  });

  it("IMAGE: stores the file and a GENERATED MediaAsset; 5 credits", async () => {
    const T = await compedTenant("ai-image");
    const done = await run(T.ctx, { type: "IMAGE", prompt: "Latte art on a wooden table", options: { aspectRatio: "4:5" } });
    const out = done.output as { mediaAssetId: string };
    const asset = await tenantDb(T.workspace.id).mediaAsset.findUniqueOrThrow({ where: { id: out.mediaAssetId } });
    expect(asset).toMatchObject({ kind: "IMAGE", source: "GENERATED", mimeType: "image/png", generationRequestId: done.id, width: 864, height: 1080 });
    expect(asset.storageKey).toMatch(new RegExp(`^workspaces/${T.workspace.id}/`));
    expect((await getStorage().get(asset.storageKey)).body.subarray(1, 4).toString()).toBe("PNG");
    expect(done.creditsCharged).toBe(5);
  });

  it("VIDEO: 25 credits on a plan with video; blocked on Free", async () => {
    const T = await compedTenant("ai-video");
    const done = await run(T.ctx, { type: "VIDEO", prompt: "Steam rising from a cup", options: { aspectRatio: "9:16" } });
    expect(done).toMatchObject({ status: "SUCCEEDED", creditsCharged: 25 });

    const F = await makeTenant("ai-free");
    await expect(requestGeneration(ctxFor(F.admin.id, F.workspace.id, "WORKSPACE_ADMIN"), { type: "VIDEO", prompt: "nope video" })).rejects.toBeInstanceOf(LimitExceededError);
  });

  it("admin-configured credit costs apply", async () => {
    await setCreditCosts(adminId, { TEXT: 3, IMAGE: 5, VIDEO: 25 });
    const T = await compedTenant("ai-costs");
    expect((await run(T.ctx, { type: "TEXT", prompt: "custom cost check" })).creditsCharged).toBe(3);
    await setCreditCosts(adminId, { TEXT: 1, IMAGE: 5, VIDEO: 25 });
  });

  it("validates input", async () => {
    const T = await compedTenant("ai-validate");
    await expect(requestGeneration(T.ctx, { type: "TEXT", prompt: "a" })).rejects.toThrow();
    await expect(requestGeneration(T.ctx, { type: "TEXT", prompt: "x".repeat(4001) })).rejects.toThrow();
    await expect(requestGeneration(T.ctx, { type: "TEXT", prompt: "valid prompt", model: "bad model!" })).rejects.toThrow();
    await expect(requestGeneration(T.ctx, { type: "IMAGE", prompt: "valid prompt", provider: "ANTHROPIC" })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("routing, fallback and refusals", () => {
  it("falls back to the next provider on a retryable failure and charges once", async () => {
    process.env.OPENAI_API_KEY = "sk-platform-openai";
    process.env.GOOGLE_AI_API_KEY = "platform-google";
    fakeText("OPENAI", "fail");
    fakeText("GOOGLE", "ok");
    const T = await compedTenant("ai-fallback");
    const done = await run(T.ctx, { type: "TEXT", prompt: "fallback please", provider: "OPENAI" });
    expect(done).toMatchObject({ status: "SUCCEEDED", provider: "GOOGLE", fallbackFrom: "OPENAI", creditsCharged: 1 });
    expect((done.attemptLog as { provider: string; ok: boolean }[]).map((a) => [a.provider, a.ok])).toEqual([["OPENAI", false], ["GOOGLE", true]]);
    expect(await netCredits(T.workspace.id)).toBe(1);
  });

  it("a refusal stops the chain (no vendor-shopping) and refunds credits", async () => {
    process.env.OPENAI_API_KEY = "sk-platform-openai";
    process.env.GOOGLE_AI_API_KEY = "platform-google";
    fakeText("OPENAI", "refuse");
    const googleCalls = fakeText("GOOGLE", "ok");
    const T = await compedTenant("ai-refuse");
    const done = await run(T.ctx, { type: "TEXT", prompt: "something refused", provider: "OPENAI" });
    expect(done.status).toBe("FAILED");
    expect(done.error).toMatch(/declined/);
    expect(googleCalls).toHaveLength(0);
    expect(await netCredits(T.workspace.id)).toBe(0);
  });

  it("all providers failing → FAILED with a safe message, credits refunded", async () => {
    process.env.OPENAI_API_KEY = "sk-platform-openai";
    fakeText("OPENAI", "fail");
    const T = await compedTenant("ai-allfail");
    const done = await run(T.ctx, { type: "TEXT", prompt: "everything is down" });
    expect(done.status).toBe("FAILED");
    expect(done.error).not.toContain("sk-");
    expect(await netCredits(T.workspace.id)).toBe(0);
  });

  it("workspace preferences pick the default provider + model", async () => {
    process.env.OPENAI_API_KEY = "sk-platform-openai";
    process.env.GOOGLE_AI_API_KEY = "platform-google";
    const openai = fakeText("OPENAI", "ok");
    fakeText("GOOGLE", "ok");
    const T = await compedTenant("ai-prefs");
    await updatePreferences(T.ctx, { TEXT: { provider: "GOOGLE" }, IMAGE: { provider: "AUTO" }, VIDEO: { provider: "AUTO" } });
    expect((await run(T.ctx, { type: "TEXT", prompt: "use my default" })).provider).toBe("GOOGLE");
    // Per-generation override beats the workspace default.
    const o = await run(T.ctx, { type: "TEXT", prompt: "override it", provider: "OPENAI", model: "gpt-special" });
    expect(o).toMatchObject({ provider: "OPENAI", model: "gpt-special" });
    expect(openai.at(-1)?.model).toBe("gpt-special");
    await expect(updatePreferences(T.ctx, { TEXT: { provider: "AUTO" }, IMAGE: { provider: "ANTHROPIC" }, VIDEO: { provider: "AUTO" } })).rejects.toThrow(/can't generate/);
  });

  it("requesting an unconfigured provider explicitly is rejected up front", async () => {
    const T = await compedTenant("ai-unconfigured");
    await expect(requestGeneration(T.ctx, { type: "TEXT", prompt: "use openai", provider: "OPENAI" })).rejects.toThrow(/isn't available/);
  });
});

describe("keys and credits", () => {
  it("BYOK: the workspace's key is used and no platform credits are charged", async () => {
    process.env.OPENAI_API_KEY = "sk-platform-openai";
    const calls = fakeText("OPENAI", "ok");
    const T = await compedTenant("ai-byok"); // pro: byok feature on
    await setWorkspaceKey(T.ctx, "OPENAI", "sk-workspace-own-key-1234");
    const done = await run(T.ctx, { type: "TEXT", prompt: "bring my own key" });
    expect(calls.at(-1)?.apiKey).toBe("sk-workspace-own-key-1234");
    expect(done).toMatchObject({ usedByok: true, creditsCharged: 0 });
    expect(await netCredits(T.workspace.id)).toBe(0);

    const stored = await tenantDb(T.workspace.id).providerCredential.findFirstOrThrow({ where: { provider: "OPENAI" } });
    expect(stored.encryptedKey).not.toContain("sk-workspace");
    expect(stored.last4).toBe("1234");
    // Another workspace can't see the key (RLS).
    const other = await makeTenant("ai-byok-other");
    expect(await tenantDb(other.workspace.id).providerCredential.count({ where: { workspaceId: T.workspace.id } })).toBe(0);
  });

  it("BYOK requires the plan feature", async () => {
    const F = await makeTenant("ai-byok-free");
    await expect(setWorkspaceKey(ctxFor(F.admin.id, F.workspace.id, "WORKSPACE_ADMIN"), "OPENAI", "sk-free-plan-key")).rejects.toBeInstanceOf(LimitExceededError);
  });

  it("platform keys are encrypted in the DB and take precedence over env", async () => {
    process.env.OPENAI_API_KEY = "sk-from-env";
    expect(await getPlatformKey("OPENAI")).toEqual({ key: "sk-from-env", source: "env" });
    await setPlatformKey(adminId, "OPENAI", "sk-from-admin-console-9876");
    const row = await systemDb.providerCredential.findFirstOrThrow({ where: { workspaceId: null, provider: "OPENAI" } });
    expect(row.encryptedKey).not.toContain("sk-from-admin");
    expect(await getPlatformKey("OPENAI")).toEqual({ key: "sk-from-admin-console-9876", source: "db" });
    await removePlatformKey(adminId, "OPENAI");
    expect((await getPlatformKey("OPENAI"))?.source).toBe("env");
  });

  it("out of credits: blocked at request time", async () => {
    const plan = await systemDb.plan.findUniqueOrThrow({ where: { key: "free" } });
    const T = await makeTenant("ai-broke");
    await compWorkspace(adminId, T.workspace.id, { planId: plan.id, reason: "credit test", overrides: { limits: { monthlyCredits: 4 } } });
    const ctx = ctxFor(T.admin.id, T.workspace.id, "WORKSPACE_ADMIN");
    await expect(requestGeneration(ctx, { type: "IMAGE", prompt: "costs five credits" })).rejects.toThrow(/Not enough AI credits/);
    expect((await run(ctx, { type: "TEXT", prompt: "costs one credit" })).status).toBe("SUCCEEDED");
  });

  it("out of credits by the time the worker runs → FAILED, nothing charged", async () => {
    const plan = await systemDb.plan.findUniqueOrThrow({ where: { key: "free" } });
    const T = await makeTenant("ai-race");
    await compWorkspace(adminId, T.workspace.id, { planId: plan.id, reason: "race test", overrides: { limits: { monthlyCredits: 1 } } });
    const ctx = ctxFor(T.admin.id, T.workspace.id, "WORKSPACE_ADMIN");
    const a = await requestGeneration(ctx, { type: "TEXT", prompt: "first one" });
    const b = await requestGeneration(ctx, { type: "TEXT", prompt: "second one" });
    expect((await processGeneration(a.id)).status).toBe("SUCCEEDED");
    const failed = await processGeneration(b.id);
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toMatch(/Not enough AI credits/);
    expect(await netCredits(T.workspace.id)).toBe(1);
  });

  it("charging and refunding are idempotent per generation; processing twice is a no-op", async () => {
    const T = await compedTenant("ai-idem");
    const req = await requestGeneration(T.ctx, { type: "TEXT", prompt: "only once please" });
    await chargeGeneration(T.workspace.id, req.id, 1);
    await chargeGeneration(T.workspace.id, req.id, 1);
    expect(await netCredits(T.workspace.id)).toBe(1);
    expect(await refundGeneration(T.workspace.id, req.id)).toBe(1);
    expect(await refundGeneration(T.workspace.id, req.id)).toBe(0);
    expect(await netCredits(T.workspace.id)).toBe(0);

    const done = await processGeneration(req.id);
    const again = await processGeneration(req.id);
    expect(again.completedAt).toEqual(done.completedAt);
    expect(await netCredits(T.workspace.id)).toBe(1);
  });
});

describe("tenancy + permissions", () => {
  it("another workspace can't read a generation or its media", async () => {
    const A = await compedTenant("ai-iso-a");
    const B = await compedTenant("ai-iso-b");
    const done = await run(A.ctx, { type: "IMAGE", prompt: "private image" });
    await expect(getGeneration(B.ctx, done.id)).rejects.toBeInstanceOf(NotFoundError);
    const assetId = (done.output as { mediaAssetId: string }).mediaAssetId;
    expect(await B.ctx.db.mediaAsset.findUnique({ where: { id: assetId } })).toBeNull();
  });

  it("members can generate; rate limit applies per workspace", async () => {
    vi.stubEnv("RATE_LIMIT_GENERATIONS_PER_MIN", "2");
    const T = await compedTenant("ai-rate");
    const member = ctxFor(T.admin.id, T.workspace.id, "MEMBER");
    await requestGeneration(member, { type: "TEXT", prompt: "one one one" });
    await requestGeneration(member, { type: "TEXT", prompt: "two two two" });
    await expect(requestGeneration(member, { type: "TEXT", prompt: "three three" })).rejects.toThrow(/Too many/);
    vi.unstubAllEnvs();
  });
});
