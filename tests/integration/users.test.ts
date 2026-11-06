import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { EmailTakenError, registerUser, verifyCredentials } from "@/server/services/users";

const DOMAIN = "@itest.local";
const email = (n: string) => `${n}-${Date.now()}${DOMAIN}`;

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: DOMAIN } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await db.workspace.deleteMany({ where: { memberships: { some: { userId: { in: ids } } } } });
  await db.auditLog.deleteMany({ where: { actorId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await cleanup();
  await db.plan.upsert({
    where: { key: "free" },
    update: {},
    create: { key: "free", name: "Free", maxPostsPerMonth: 10, monthlyCredits: 20, maxSocialAccounts: 2, maxMembers: 1 },
  });
});
afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

describe("registerUser", () => {
  it("creates user, workspace (as admin), free subscription and audit entry atomically", async () => {
    const e = email("signup");
    const { user, workspace } = await registerUser({ name: "Ada", email: e, password: "longpassword1", workspaceName: "Ada's Bakery" });

    expect(user.passwordHash).toBeTruthy();
    expect(user.passwordHash).not.toContain("longpassword1");
    expect(user.platformRole).toBe("USER");
    expect(workspace.slug).toMatch(/^adas-bakery/);

    const membership = await db.membership.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } } });
    expect(membership?.role).toBe("WORKSPACE_ADMIN");

    const sub = await db.subscription.findUnique({ where: { workspaceId: workspace.id }, include: { plan: true } });
    expect(sub?.plan.key).toBe("free");
    expect(sub?.isComped).toBe(false);

    expect(await db.auditLog.count({ where: { action: "auth.signup", actorId: user.id } })).toBe(1);
  });

  it("rejects a duplicate email without leaving a partial workspace", async () => {
    const e = email("dupe");
    await registerUser({ name: "A", email: e, password: "longpassword1", workspaceName: "First" });
    const before = await db.workspace.count();
    await expect(
      registerUser({ name: "B", email: e.toUpperCase(), password: "longpassword1", workspaceName: "Second" }),
    ).rejects.toBeInstanceOf(EmailTakenError);
    expect(await db.workspace.count()).toBe(before);
  });

  it("gives colliding workspace names unique slugs", async () => {
    const a = await registerUser({ name: "A", email: email("slug-a"), password: "longpassword1", workspaceName: "Same Name" });
    const b = await registerUser({ name: "B", email: email("slug-b"), password: "longpassword1", workspaceName: "Same Name" });
    expect(a.workspace.slug).not.toBe(b.workspace.slug);
  });
});

describe("verifyCredentials", () => {
  it("accepts correct credentials (case-insensitive email) and rejects wrong ones", async () => {
    const e = email("login");
    await registerUser({ name: "L", email: e, password: "longpassword1", workspaceName: "Login Co" });

    expect((await verifyCredentials({ email: e.toUpperCase(), password: "longpassword1" }))?.email).toBe(e);
    expect(await verifyCredentials({ email: e, password: "wrongpassword1" })).toBeNull();
    expect(await verifyCredentials({ email: `nobody${DOMAIN}`, password: "longpassword1" })).toBeNull();
    expect(await verifyCredentials({ email: "not-an-email", password: "" })).toBeNull();
  });

  it("rejects disabled users", async () => {
    const e = email("disabled");
    const { user } = await registerUser({ name: "D", email: e, password: "longpassword1", workspaceName: "Disabled Co" });
    await db.user.update({ where: { id: user.id }, data: { disabledAt: new Date() } });
    expect(await verifyCredentials({ email: e, password: "longpassword1" })).toBeNull();
  });
});
