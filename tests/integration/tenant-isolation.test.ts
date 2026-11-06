/**
 * Phase 1 acceptance: a workspace can never read or write another workspace's data.
 * These tests deliberately write "buggy" queries (no workspace filter, foreign ids)
 * and assert the database refuses them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, systemDb, tenantDb, withTenantTx } from "@/lib/db";
import { assertRlsEnforced } from "@/lib/db-guard";
import { cleanupTestData, makeTenant } from "./fixtures";

type Tenant = Awaited<ReturnType<typeof makeTenant>>;
let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  await cleanupTestData();
  [A, B] = await Promise.all([makeTenant("alpha"), makeTenant("bravo")]);
});
afterAll(async () => {
  await cleanupTestData();
  await db.$disconnect();
});

const RLS_VIOLATION = /row-level security|violates row-level/i;

describe("runtime database role", () => {
  it("is not a superuser / BYPASSRLS role (otherwise RLS would be skipped)", async () => {
    const r = await assertRlsEnforced();
    expect(r.ok, `role ${r.role} bypasses RLS: set TEST_DATABASE_URL to an app_user member`).toBe(true);
  });
});

describe("reads", () => {
  it("unfiltered findMany only returns the current tenant's rows", async () => {
    const posts = await tenantDb(A.workspace.id).post.findMany();
    expect(posts.map((p) => p.id)).toContain(A.post.id);
    expect(posts.map((p) => p.id)).not.toContain(B.post.id);
    expect(posts.every((p) => p.workspaceId === A.workspace.id)).toBe(true);
  });

  it("findUnique by another tenant's id returns null", async () => {
    const a = tenantDb(A.workspace.id);
    expect(await a.post.findUnique({ where: { id: B.post.id } })).toBeNull();
    expect(await a.socialAccount.findUnique({ where: { id: B.account.id } })).toBeNull();
    expect(await a.workspace.findUnique({ where: { id: B.workspace.id } })).toBeNull();
    expect(await a.mediaAsset.findUnique({ where: { id: B.media.id } })).toBeNull();
  });

  it("explicitly asking for another workspaceId still returns nothing", async () => {
    expect(await tenantDb(A.workspace.id).post.findMany({ where: { workspaceId: B.workspace.id } })).toEqual([]);
  });

  it("child tables (PostTarget, PostSchedule) are scoped through their parent", async () => {
    const a = tenantDb(A.workspace.id);
    const targets = await a.postTarget.findMany();
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t) => t.postId === A.post.id || t.postId !== B.post.id)).toBe(true);
    expect(await a.postTarget.findMany({ where: { postId: B.post.id } })).toEqual([]);
    expect(await a.postSchedule.findMany({ where: { postId: B.post.id } })).toEqual([]);
  });

  it("aggregates and counts are scoped", async () => {
    const total = await systemDb.post.count({ where: { id: { in: [A.post.id, B.post.id] } } });
    expect(total).toBe(2);
    expect(await tenantDb(A.workspace.id).post.count({ where: { id: { in: [A.post.id, B.post.id] } } })).toBe(1);
  });

  it("includes don't leak across tenants (memberships of a workspace)", async () => {
    const ws = await tenantDb(A.workspace.id).workspace.findMany({ include: { memberships: true, posts: true } });
    expect(ws).toHaveLength(1);
    expect(ws[0]!.id).toBe(A.workspace.id);
  });

  it("raw client with no tenant context sees no tenant rows (fail closed)", async () => {
    expect(await db.post.findUnique({ where: { id: A.post.id } })).toBeNull();
    expect(await db.workspace.count({ where: { id: { in: [A.workspace.id, B.workspace.id] } } })).toBe(0);
  });

  it("interactive tenant transactions are scoped too, including raw SQL", async () => {
    const rows = await withTenantTx(A.workspace.id, (tx) =>
      tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Post" WHERE id IN (${A.post.id}, ${B.post.id})`,
    );
    expect(rows.map((r) => r.id)).toEqual([A.post.id]);
  });
});

describe("writes", () => {
  it("update by another tenant's id fails as not found", async () => {
    await expect(
      tenantDb(A.workspace.id).post.update({ where: { id: B.post.id }, data: { content: "pwned" } }),
    ).rejects.toMatchObject({ code: "P2025" });
    expect((await systemDb.post.findUnique({ where: { id: B.post.id } }))!.content).toBe("bravo secret post");
  });

  it("unfiltered updateMany / deleteMany only touch the current tenant", async () => {
    const a = tenantDb(A.workspace.id);
    const updated = await a.post.updateMany({ data: { platformOverrides: { touched: true } } });
    expect(updated.count).toBeGreaterThanOrEqual(1);
    const bPost = await systemDb.post.findUnique({ where: { id: B.post.id } });
    expect(bPost!.platformOverrides).toEqual({});

    const deleted = await a.postSchedule.deleteMany({});
    expect(deleted.count).toBe(1);
    expect(await systemDb.postSchedule.count({ where: { postId: B.post.id } })).toBe(1);
  });

  it("delete by another tenant's id fails", async () => {
    await expect(tenantDb(A.workspace.id).socialAccount.delete({ where: { id: B.account.id } })).rejects.toMatchObject({ code: "P2025" });
    expect(await systemDb.socialAccount.count({ where: { id: B.account.id } })).toBe(1);
  });

  it("cannot create rows in another workspace", async () => {
    await expect(
      tenantDb(A.workspace.id).post.create({ data: { workspaceId: B.workspace.id, content: "planted" } }),
    ).rejects.toThrow(RLS_VIOLATION);
    expect(await systemDb.post.count({ where: { content: "planted" } })).toBe(0);
  });

  it("cannot move a row to another workspace", async () => {
    await expect(
      tenantDb(A.workspace.id).post.update({ where: { id: A.post.id }, data: { workspaceId: B.workspace.id } }),
    ).rejects.toThrow(RLS_VIOLATION);
  });

  it("cannot link own post to another tenant's social account", async () => {
    await expect(
      tenantDb(A.workspace.id).postTarget.create({ data: { postId: A.post.id, socialAccountId: B.account.id } }),
    ).rejects.toThrow(RLS_VIOLATION);
  });

  it("cannot link via nested create either", async () => {
    await expect(
      tenantDb(A.workspace.id).post.create({
        data: { workspaceId: A.workspace.id, content: "nested", targets: { create: { socialAccountId: B.account.id } } },
      }),
    ).rejects.toThrow(RLS_VIOLATION);
    // The whole nested write rolled back.
    expect(await systemDb.post.count({ where: { content: "nested" } })).toBe(0);
  });

  it("cannot attach another tenant's media to own post", async () => {
    await expect(
      tenantDb(A.workspace.id).postMedia.create({ data: { postId: A.post.id, mediaAssetId: B.media.id } }),
    ).rejects.toThrow(RLS_VIOLATION);
  });

  it("cannot add a schedule to another tenant's post", async () => {
    await systemDb.postSchedule.deleteMany({ where: { postId: B.post.id } });
    await expect(
      tenantDb(A.workspace.id).postSchedule.create({ data: { postId: B.post.id, scheduledAt: new Date() } }),
    ).rejects.toThrow(RLS_VIOLATION);
  });

  it("cannot add self as a member of another workspace", async () => {
    await expect(
      tenantDb(A.workspace.id).membership.create({ data: { userId: A.admin.id, workspaceId: B.workspace.id, role: "WORKSPACE_ADMIN" } }),
    ).rejects.toThrow(RLS_VIOLATION);
  });

  it("raw client with no tenant context cannot write tenant rows", async () => {
    await expect(db.post.create({ data: { workspaceId: A.workspace.id, content: "no ctx" } })).rejects.toThrow(RLS_VIOLATION);
  });

  it("the happy path works: tenant can create and link its own rows", async () => {
    const a = tenantDb(A.workspace.id);
    const p = await a.post.create({
      data: {
        workspaceId: A.workspace.id,
        content: "legit",
        targets: { create: { socialAccountId: A.account.id } },
        media: { create: { mediaAssetId: A.media.id } },
      },
      include: { targets: true, media: true },
    });
    expect(p.targets).toHaveLength(1);
    expect(p.media).toHaveLength(1);
  });
});

describe("tenantDb input validation", () => {
  it("rejects malformed workspace ids (e.g. SQL fragments)", () => {
    expect(() => tenantDb("x' OR '1'='1")).toThrow(/invalid workspaceId/);
    expect(() => tenantDb("")).toThrow();
  });
});
