import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptSecret } from "@/lib/crypto";
import { db, systemDb, tenantDb } from "@/lib/db";
import { QUEUES, getQueue } from "@/lib/queues";
import { forceSignOut, listUsers, listWorkspaces, queryAudit, setPlatformRole, setUserDisabled, setWorkspaceSuspended } from "@/server/admin/management";
import { getOpsOverview } from "@/server/admin/ops";
import { dayKeys, platformAnalytics, workspaceAnalytics } from "@/server/analytics";
import { compWorkspace } from "@/server/billing/comp";
import { ConflictError, ForbiddenError } from "@/server/errors";
import { processPublishJob } from "@/server/scheduling/publish-run";
import { savePost, schedulePost } from "@/server/scheduling/posts";
import { auditActor } from "@/server/services/audit";
import { assertCan } from "@/server/tenancy/guard";
import { cleanupTestData, ctxFor, makeTenant, testEmail } from "./fixtures";

process.env.MOCK_PUBLISH_DELAY_MS = "0";
let admin: { id: string };

beforeAll(async () => {
  await cleanupTestData();
  admin = await systemDb.user.create({ data: { email: testEmail("p6-admin"), platformRole: "SUPER_ADMIN" } });
});
afterAll(async () => {
  await getQueue(QUEUES.publish).obliterate({ force: true });
  await getQueue(QUEUES.publish).close();
  await cleanupTestData();
  await db.$disconnect();
});

describe("impersonation guards", () => {
  it("blocks billing and AI-key permissions while impersonating, allows the rest", () => {
    const ctx = { role: "WORKSPACE_ADMIN" as const, impersonatorId: "admin-1" };
    expect(() => assertCan(ctx, "billing.manage")).toThrow(ForbiddenError);
    expect(() => assertCan(ctx, "settings.ai")).toThrow(/impersonating/);
    expect(() => assertCan(ctx, "content.publish")).not.toThrow();
    expect(() => assertCan(ctx, "members.manage")).not.toThrow();
    expect(() => assertCan({ role: "WORKSPACE_ADMIN" }, "billing.manage")).not.toThrow();
  });

  it("actions taken while impersonating are audited with the impersonator", async () => {
    const t = await makeTenant("p6-imp");
    const ctx = { ...ctxFor(admin.id, t.workspace.id, "WORKSPACE_ADMIN"), impersonatorId: admin.id };
    expect(auditActor(ctx)).toEqual({ actorId: admin.id, workspaceId: t.workspace.id, impersonatorId: admin.id });
    const post = await savePost(ctx, { content: "support fixed this", accountIds: [t.account.id] });
    await schedulePost(ctx, post.id, { mode: "now" });
    const log = await systemDb.auditLog.findFirstOrThrow({ where: { action: "post.publish_now", targetId: post.id } });
    expect(log.impersonatorId).toBe(admin.id);
    const audit = await queryAudit({ impersonatedOnly: true, workspaceId: t.workspace.id });
    expect(audit.rows.map((r) => r.action)).toContain("post.publish_now");
  });
});

describe("user management", () => {
  it("disable revokes sessions; enable restores; can't disable yourself", async () => {
    const u = await systemDb.user.create({ data: { email: testEmail("p6-user") } });
    await setUserDisabled(admin.id, u.id, true, "abuse report");
    const after = await systemDb.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(after.disabledAt).toBeTruthy();
    expect(after.sessionVersion).toBe(u.sessionVersion + 1);
    await setUserDisabled(admin.id, u.id, false);
    expect((await systemDb.user.findUniqueOrThrow({ where: { id: u.id } })).disabledAt).toBeNull();
    await expect(setUserDisabled(admin.id, admin.id, true)).rejects.toBeInstanceOf(ConflictError);
  });

  it("force sign-out bumps the session version", async () => {
    const u = await systemDb.user.create({ data: { email: testEmail("p6-signout") } });
    await forceSignOut(admin.id, u.id);
    expect((await systemDb.user.findUniqueOrThrow({ where: { id: u.id } })).sessionVersion).toBe(1);
  });

  it("grant/revoke SUPER_ADMIN with last-admin and self-demotion guards", async () => {
    const u = await systemDb.user.create({ data: { email: testEmail("p6-promote") } });
    await setPlatformRole(admin.id, u.id, "SUPER_ADMIN");
    expect((await systemDb.user.findUniqueOrThrow({ where: { id: u.id } })).platformRole).toBe("SUPER_ADMIN");
    await expect(setPlatformRole(admin.id, admin.id, "USER")).rejects.toThrow(/your own/);
    await setPlatformRole(admin.id, u.id, "USER");

    // With every other super admin disabled, the remaining one can't be demoted or disabled.
    const others = await systemDb.user.findMany({ where: { platformRole: "SUPER_ADMIN", disabledAt: null, id: { not: admin.id } } });
    await systemDb.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { disabledAt: new Date() } });
    const solo = await systemDb.user.create({ data: { email: testEmail("p6-solo") } });
    await expect(setUserDisabled(solo.id, admin.id, true)).rejects.toThrow(/last active SUPER_ADMIN/);
    await systemDb.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { disabledAt: null } });
  });

  it("lists and searches users", async () => {
    const r = await listUsers({ q: "p6-promote" });
    expect(r.rows.some((x) => x.email.includes("p6-promote"))).toBe(true);
    expect((await listUsers({ filter: "admins" })).rows.every((x) => x.platformRole === "SUPER_ADMIN")).toBe(true);
  });
});

describe("workspace management", () => {
  it("filters by comped / suspended / free and searches by member email", async () => {
    const comped = await makeTenant("p6-comped");
    const plan = await systemDb.plan.upsert({ where: { key: "free" }, update: {}, create: { key: "free", name: "Free", maxPostsPerMonth: 10, monthlyCredits: 20, maxSocialAccounts: 2, maxMembers: 1 } });
    await compWorkspace(admin.id, comped.workspace.id, { planId: plan.id, reason: "p6 filter" });
    const susp = await makeTenant("p6-susp");
    await setWorkspaceSuspended(admin.id, susp.workspace.id, true, "chargeback");

    expect((await listWorkspaces({ filter: "comped", q: "p6-comped" })).rows.map((r) => r.id)).toContain(comped.workspace.id);
    expect((await listWorkspaces({ filter: "suspended", q: "p6-susp" })).rows.map((r) => r.id)).toEqual([susp.workspace.id]);
    expect((await listWorkspaces({ filter: "free", q: "p6-comped" })).rows.map((r) => r.id)).not.toContain(comped.workspace.id);
    expect((await listWorkspaces({ q: susp.admin.email })).rows.map((r) => r.id)).toContain(susp.workspace.id);
    await expect(setWorkspaceSuspended(admin.id, susp.workspace.id, true, "again")).rejects.toBeInstanceOf(ConflictError);
    await expect(setWorkspaceSuspended(admin.id, comped.workspace.id, true, "")).rejects.toThrow();
  });

  it("a suspended workspace's due posts fail clearly instead of publishing", async () => {
    const t = await makeTenant("p6-susp-pub");
    const ctx = ctxFor(t.admin.id, t.workspace.id, "WORKSPACE_ADMIN");
    const post = await savePost(ctx, { content: "should not go out", accountIds: [t.account.id] });
    await schedulePost(ctx, post.id, { mode: "now" });
    await setWorkspaceSuspended(admin.id, t.workspace.id, true, "policy");
    expect((await processPublishJob(post.id)).status).toBe("FAILED");
    const target = await systemDb.postTarget.findFirstOrThrow({ where: { postId: post.id } });
    expect(target.lastError).toMatch(/suspended/);
    expect(target.externalPostId).toBeNull();
  });
});

describe("audit query", () => {
  it("filters by action, actor email and date", async () => {
    const r = await queryAudit({ action: "admin.workspace.suspend", actor: "p6-admin" });
    expect(r.total).toBeGreaterThanOrEqual(1);
    expect(r.rows.every((x) => x.action.includes("admin.workspace.suspend") && x.actor?.email.includes("p6-admin"))).toBe(true);
    expect((await queryAudit({ action: "admin.workspace.suspend", from: "2000-01-01", to: "2000-01-02" })).total).toBe(0);
  });
});

describe("analytics", () => {
  it("dayKeys returns N consecutive UTC days ending today", () => {
    const k = dayKeys(30, new Date("2026-03-31T12:00:00Z"));
    expect(k).toHaveLength(30);
    expect([k[0], k[29]]).toEqual(["2026-03-02", "2026-03-31"]);
  });

  it("counts published targets and generations per day, zero-filled; workspace analytics are tenant-scoped", async () => {
    const A = await makeTenant("p6-an-a");
    const B = await makeTenant("p6-an-b");
    for (const [t, n] of [[A, 2], [B, 1]] as const) {
      const ctx = ctxFor(t.admin.id, t.workspace.id, "WORKSPACE_ADMIN");
      for (let i = 0; i < n; i++) {
        const p = await savePost(ctx, { content: `analytics ${i}`, accountIds: [t.account.id] });
        await schedulePost(ctx, p.id, { mode: "now" });
        await processPublishJob(p.id);
      }
    }
    await tenantDb(A.workspace.id).generationRequest.create({ data: { workspaceId: A.workspace.id, type: "IMAGE", prompt: "x", provider: "MOCK", status: "SUCCEEDED", completedAt: new Date() } });

    const a = await workspaceAnalytics(A.workspace.id, 30);
    expect(a.published).toHaveLength(30);
    expect(a.published.at(-1)!.values[0]).toBe(2); // only A's two posts, not B's
    expect(a.published.slice(0, 29).every((d) => d.values[0] === 0)).toBe(true);
    expect(a.generations.at(-1)!.values).toEqual([0, 1, 0]); // TEXT, IMAGE, VIDEO
    expect(a.platforms).toEqual([{ platform: "X", published: 2, failed: 0, total: 2, rate: 1 }]);

    const p = await platformAnalytics(30);
    expect(p.published.at(-1)!.values[0]).toBeGreaterThanOrEqual(3);
    expect(p.signups.at(-1)!.values[0]).toBeGreaterThanOrEqual(2);
  });

  it("ops overview lists failed targets, unhealthy accounts and queue counts", async () => {
    const t = await makeTenant("p6-ops");
    await tenantDb(t.workspace.id).socialAccount.update({ where: { id: t.account.id }, data: { status: "EXPIRED", accessTokenEnc: encryptSecret("x") } });
    const o = await getOpsOverview(7);
    expect(o.unhealthyAccounts.map((a) => a.id)).toContain(t.account.id);
    expect(o.failedTargets.some((f) => f.lastError?.includes("suspended"))).toBe(true);
    expect(o.queues.map((q) => q.name)).toEqual(["publish", "generation", "system"]);
  });
});
