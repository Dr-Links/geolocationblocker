import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptSecret } from "@/lib/crypto";
import { db, systemDb, tenantDb } from "@/lib/db";
import { verifyToken } from "@/lib/signed-token";
import { compWorkspace } from "@/server/billing/comp";
import { ConflictError, ForbiddenError, LimitExceededError } from "@/server/errors";
import {
  checkAccountHealth,
  completeConnect,
  disconnectAccount,
  ensureFreshCredentials,
  refreshExpiringTokens,
  startConnect,
  validateForAccounts,
} from "@/server/social/accounts";
import { mockAuthCode } from "@/server/social/publishers/mock";
import { overridePublisher } from "@/server/social/registry";
import type { SocialPublisher } from "@/server/social/types";
import { addMember, cleanupTestData, ctxFor, makeTenant, testEmail } from "./fixtures";

process.env.MOCK_PUBLISH_DELAY_MS = "0";
let adminId: string;

type Ctx = ReturnType<typeof ctxFor>;

/** Run the whole OAuth round trip through the mock consent screen. */
async function connectMock(ctx: Ctx, platform: string, handle: string) {
  const { url, cookie } = await startConnect(ctx, platform);
  const state = new URL(url).searchParams.get("state")!;
  return completeConnect(ctx, platform, { code: mockAuthCode(platform.toUpperCase() as never, handle), state, cookie });
}

async function tenant(label: string, accountLimit?: number) {
  const t = await makeTenant(label); // fixture already has 1 X account
  const plan = await systemDb.plan.upsert({
    where: { key: "free" },
    update: {},
    create: { key: "free", name: "Free", maxPostsPerMonth: 10, monthlyCredits: 20, maxSocialAccounts: 2, maxMembers: 1 },
  });
  if (accountLimit !== undefined) {
    await compWorkspace(adminId, t.workspace.id, { planId: plan.id, reason: "social tests", overrides: { limits: { maxSocialAccounts: accountLimit, maxMembers: -1 } } });
  }
  return { ...t, ctx: ctxFor(t.admin.id, t.workspace.id, "WORKSPACE_ADMIN") };
}

beforeAll(async () => {
  await cleanupTestData();
  adminId = (await systemDb.user.create({ data: { email: testEmail("social-admin"), platformRole: "SUPER_ADMIN" } })).id;
});
afterAll(async () => {
  overridePublisher("X", undefined);
  await cleanupTestData();
  await db.$disconnect();
});

describe("OAuth connect (mock publisher)", () => {
  it("start → consent → callback stores an encrypted, connected account", async () => {
    const T = await tenant("soc-connect", 10);
    const { url, cookie, isMock } = await startConnect(T.ctx, "instagram");
    expect(isMock).toBe(true);
    const u = new URL(url);
    expect(u.pathname).toBe("/connect/mock");
    expect(u.searchParams.get("redirect_uri")).toMatch(/\/api\/social\/callback\/instagram$/);
    // The cookie binds state + PKCE verifier to this user and workspace.
    const bound = verifyToken<{ s: string; w: string; u: string; v: string }>(cookie, "social-oauth")!;
    expect(bound).toMatchObject({ s: u.searchParams.get("state"), w: T.workspace.id, u: T.admin.id });
    expect(bound.v.length).toBeGreaterThan(40);

    const r = await completeConnect(T.ctx, "instagram", { code: mockAuthCode("INSTAGRAM", "acme_ig"), state: u.searchParams.get("state"), cookie });
    expect(r.connected).toEqual(["acme_ig"]);
    const acct = await tenantDb(T.workspace.id).socialAccount.findFirstOrThrow({ where: { platform: "INSTAGRAM" } });
    expect(acct).toMatchObject({ status: "CONNECTED", isMock: true, handle: "@acme_ig" });
    expect(acct.accessTokenEnc).not.toContain("mock_at_");
    expect(acct.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await systemDb.auditLog.count({ where: { action: "social.account.connect", targetId: acct.id } })).toBe(1);
  });

  it("reconnecting the same account updates it instead of duplicating", async () => {
    const T = await tenant("soc-reconnect", 10);
    await connectMock(T.ctx, "linkedin", "acme");
    await connectMock(T.ctx, "linkedin", "acme");
    expect(await tenantDb(T.workspace.id).socialAccount.count({ where: { platform: "LINKEDIN" } })).toBe(1);
    expect(await systemDb.auditLog.count({ where: { workspaceId: T.workspace.id, action: "social.account.reconnect" } })).toBe(1);
  });

  it("rejects a mismatched state, a forged/expired cookie, and a cancelled consent", async () => {
    const T = await tenant("soc-state", 10);
    const { cookie } = await startConnect(T.ctx, "x");
    await expect(completeConnect(T.ctx, "x", { code: mockAuthCode("X", "a"), state: "wrong", cookie })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(completeConnect(T.ctx, "x", { code: mockAuthCode("X", "a"), state: "s", cookie: "forged.cookie" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(completeConnect(T.ctx, "x", { error: "access_denied", cookie })).rejects.toThrow(/cancelled/);
    // A code minted for another platform is refused by the publisher.
    const s2 = await startConnect(T.ctx, "x");
    await expect(completeConnect(T.ctx, "x", { code: mockAuthCode("TIKTOK", "a"), state: new URL(s2.url).searchParams.get("state"), cookie: s2.cookie })).rejects.toThrow(/Invalid/);
  });

  it("a callback can't be completed in a different workspace or by a different user", async () => {
    const A = await tenant("soc-xa", 10);
    const B = await tenant("soc-xb", 10);
    const { url, cookie } = await startConnect(A.ctx, "x");
    const state = new URL(url).searchParams.get("state");
    // Same user's cookie replayed while B is the active workspace:
    await expect(completeConnect({ ...B.ctx, userId: A.admin.id }, "x", { code: mockAuthCode("X", "evil"), state, cookie })).rejects.toThrow(/different workspace/);
    expect(await tenantDb(B.workspace.id).socialAccount.count({ where: { handle: "@evil" } })).toBe(0);
  });

  it("enforces the plan's connected-account limit (start and callback)", async () => {
    const T = await tenant("soc-limit", 2); // fixture already used 1
    await connectMock(T.ctx, "x", "second");
    await expect(startConnect(T.ctx, "linkedin")).rejects.toBeInstanceOf(LimitExceededError);
    // Reconnecting an existing account is still allowed at the limit.
    await expect(connectMock(T.ctx, "x", "second")).resolves.toMatchObject({ connected: ["second"] });
  });

  it("at the limit, a 'reconnect' start that authorizes a DIFFERENT account is still refused at the callback", async () => {
    const T = await tenant("soc-limit2", 1); // the fixture X account fills the only slot
    await expect(connectMock(T.ctx, "x", "someone_else")).rejects.toBeInstanceOf(LimitExceededError);
    expect(await tenantDb(T.workspace.id).socialAccount.count()).toBe(1);
  });

  it("only workspace admins can connect or disconnect", async () => {
    const T = await tenant("soc-perm", 10);
    const { user } = await addMember(T.workspace.id);
    const member = ctxFor(user.id, T.workspace.id, "MEMBER");
    await expect(startConnect(member, "x")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(disconnectAccount(member, T.account.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects unknown platforms", async () => {
    const T = await tenant("soc-unknown", 10);
    await expect(startConnect(T.ctx, "myspace")).rejects.toThrow();
  });
});

describe("tokens, health, disconnect", () => {
  it("refreshes an expiring token before use", async () => {
    const T = await tenant("soc-refresh", 10);
    await connectMock(T.ctx, "tiktok", "tt");
    const db = tenantDb(T.workspace.id);
    const acct = await db.socialAccount.findFirstOrThrow({ where: { platform: "TIKTOK" } });
    await db.socialAccount.update({ where: { id: acct.id }, data: { tokenExpiresAt: new Date(Date.now() + 60_000) } });
    const before = await db.socialAccount.findUniqueOrThrow({ where: { id: acct.id } });

    const checked = await checkAccountHealth(T.ctx, acct.id);
    expect(checked.status).toBe("CONNECTED");
    expect(checked.accessTokenEnc).not.toBe(before.accessTokenEnc);
    expect(checked.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
  });

  it("a revoked refresh token marks the account EXPIRED (and the status persists)", async () => {
    const T = await tenant("soc-revoked", 10);
    const db = tenantDb(T.workspace.id);
    await db.socialAccount.update({
      where: { id: T.account.id },
      data: { refreshTokenEnc: encryptSecret("revoked"), tokenExpiresAt: new Date(Date.now() - 1000) },
    });
    const r = await checkAccountHealth(T.ctx, T.account.id);
    expect(r.status).toBe("EXPIRED");
    expect(r.lastError).toMatch(/revoked/i);
  });

  it("worker sweep refreshes soon-expiring tokens across workspaces and persists failures", async () => {
    const A = await tenant("soc-sweep-a", 10);
    const B = await tenant("soc-sweep-b", 10);
    await tenantDb(A.workspace.id).socialAccount.update({ where: { id: A.account.id }, data: { refreshTokenEnc: encryptSecret("rt-ok"), tokenExpiresAt: new Date(Date.now() + 3600_000) } });
    await tenantDb(B.workspace.id).socialAccount.update({ where: { id: B.account.id }, data: { refreshTokenEnc: encryptSecret("revoked"), tokenExpiresAt: new Date(Date.now() + 3600_000) } });
    const r = await refreshExpiringTokens();
    expect(r.refreshed).toBeGreaterThanOrEqual(1);
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect((await systemDb.socialAccount.findUniqueOrThrow({ where: { id: A.account.id } })).tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect((await systemDb.socialAccount.findUniqueOrThrow({ where: { id: B.account.id } })).status).toBe("EXPIRED");
  });

  it("a transient refresh failure marks ERROR (not EXPIRED)", async () => {
    const T = await tenant("soc-transient", 10);
    await tenantDb(T.workspace.id).socialAccount.update({ where: { id: T.account.id }, data: { isMock: false, refreshTokenEnc: encryptSecret("rt"), tokenExpiresAt: new Date(Date.now() - 1) } });
    const flaky = { platform: "X", isMock: false, refreshToken: async () => { throw new (await import("@/server/social/types")).PublishError("503", "X", { retryable: true }); } } as unknown as SocialPublisher;
    overridePublisher("X", flaky);
    const acct = await tenantDb(T.workspace.id).socialAccount.findUniqueOrThrow({ where: { id: T.account.id } });
    await expect(
      (await import("@/lib/db")).withTenantTx(T.workspace.id, async (tx) => {
        await ensureFreshCredentials(tx, acct).catch(() => {});
      }),
    ).resolves.toBeUndefined();
    expect((await systemDb.socialAccount.findUniqueOrThrow({ where: { id: T.account.id } })).status).toBe("ERROR");
    overridePublisher("X", undefined);
  });

  it("disconnect wipes credentials, frees the slot, and keeps the row", async () => {
    const T = await tenant("soc-disconnect", 1); // fixture account fills the only slot
    await expect(startConnect(T.ctx, "youtube")).rejects.toBeInstanceOf(LimitExceededError);
    await disconnectAccount(T.ctx, T.account.id);
    const row = await systemDb.socialAccount.findUniqueOrThrow({ where: { id: T.account.id } });
    expect(row).toMatchObject({ status: "DISCONNECTED", refreshTokenEnc: null, tokenExpiresAt: null });
    await expect(startConnect(T.ctx, "youtube")).resolves.toBeTruthy();
  });

  it("can't touch another workspace's accounts", async () => {
    const A = await tenant("soc-iso-a", 10);
    const B = await tenant("soc-iso-b", 10);
    await expect(disconnectAccount(A.ctx, B.account.id)).rejects.toThrow(/not found/i);
    await expect(checkAccountHealth(A.ctx, B.account.id)).rejects.toThrow(/not found/i);
  });
});

describe("validate a post against target accounts", () => {
  it("returns per-account results using each platform's rules", async () => {
    const T = await tenant("soc-validate", 10);
    await connectMock(T.ctx, "instagram", "acme_ig");
    const db = tenantDb(T.workspace.id);
    const ig = await db.socialAccount.findFirstOrThrow({ where: { platform: "INSTAGRAM" } });

    const results = await validateForAccounts(T.ctx, { content: "x".repeat(300), mediaAssetIds: [], accountIds: [T.account.id, ig.id] });
    const byPlatform = Object.fromEntries(results.map((r) => [r.platform, r]));
    expect(byPlatform.X!.errors.map((e) => e.code)).toContain("text_too_long");
    expect(byPlatform.INSTAGRAM!.errors.map((e) => e.code)).toContain("media_required");

    const ok = await validateForAccounts(T.ctx, { content: "Short and sweet", mediaAssetIds: [], accountIds: [T.account.id] });
    expect(ok[0]).toMatchObject({ ok: true, errors: [] });
  });

  it("flags expired/disconnected accounts and rejects foreign ids", async () => {
    const A = await tenant("soc-val-a", 10);
    const B = await tenant("soc-val-b", 10);
    await disconnectAccount(A.ctx, A.account.id);
    const [r] = await validateForAccounts(A.ctx, { content: "hi", accountIds: [A.account.id] });
    expect(r!.errors[0]!.code).toBe("account_unavailable");
    await expect(validateForAccounts(A.ctx, { content: "hi", accountIds: [B.account.id] })).rejects.toThrow(/no longer exist/);
    await expect(validateForAccounts(A.ctx, { content: "hi", accountIds: [] })).rejects.toThrow();
    void ConflictError;
  });
});
