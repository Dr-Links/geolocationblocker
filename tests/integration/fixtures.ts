import { randomBytes } from "node:crypto";
import { systemDb, withSystemTx } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { tenantDb } from "@/lib/db";
import type { TenantContext } from "@/server/tenancy/types";
import type { WorkspaceRole } from "@prisma/client";

export const TEST_DOMAIN = "@itest.local";
export const uniq = () => randomBytes(4).toString("hex");
export const testEmail = (label: string) => `${label}-${uniq()}${TEST_DOMAIN}`;

/** A workspace with an admin, one social account, one post (+target), one media asset. */
/**
 * `unlimitedSeats`: comp the workspace with unlimited members so tests about
 * invitation mechanics aren't blocked by the free plan's seat limit.
 */
export async function makeTenant(label: string, opts: { unlimitedSeats?: boolean } = {}) {
  return withSystemTx(async (tx) => {
    const admin = await tx.user.create({ data: { email: testEmail(`${label}-admin`), name: `${label} admin` } });
    const workspace = await tx.workspace.create({
      data: {
        name: `${label} ws`,
        slug: `${label}-${uniq()}`,
        memberships: { create: { userId: admin.id, role: "WORKSPACE_ADMIN" } },
      },
    });
    const account = await tx.socialAccount.create({
      data: {
        workspaceId: workspace.id,
        platform: "X",
        isMock: true,
        externalId: `ext-${uniq()}`,
        displayName: `${label} on X`,
        accessTokenEnc: encryptSecret("t"),
      },
    });
    const media = await tx.mediaAsset.create({
      data: { workspaceId: workspace.id, kind: "IMAGE", source: "UPLOAD", storageKey: `k/${uniq()}`, mimeType: "image/png" },
    });
    const post = await tx.post.create({
      data: {
        workspaceId: workspace.id,
        authorId: admin.id,
        content: `${label} secret post`,
        targets: { create: { socialAccountId: account.id } },
        schedule: { create: { scheduledAt: new Date(Date.now() + 3_600_000) } },
      },
    });
    if (opts.unlimitedSeats) {
      const free = await tx.plan.upsert({
        where: { key: "free" },
        update: {},
        create: { key: "free", name: "Free", maxPostsPerMonth: 10, monthlyCredits: 20, maxSocialAccounts: 2, maxMembers: 1 },
      });
      await tx.subscription.create({
        data: { workspaceId: workspace.id, planId: free.id, isComped: true, compPlanId: free.id, compReason: "test fixture", compOverrides: { limits: { maxMembers: -1 } } },
      });
    }
    return { admin, workspace, account, media, post };
  });
}

export async function addMember(workspaceId: string, role: WorkspaceRole = "MEMBER", label = "member") {
  return withSystemTx(async (tx) => {
    const user = await tx.user.create({ data: { email: testEmail(label), name: label } });
    const membership = await tx.membership.create({ data: { userId: user.id, workspaceId, role } });
    return { user, membership };
  });
}

export function ctxFor(userId: string, workspaceId: string, role: WorkspaceRole): TenantContext {
  return { userId, workspaceId, role, platformRole: "USER", db: tenantDb(workspaceId) };
}

export async function cleanupTestData() {
  const users = await systemDb.user.findMany({ where: { email: { endsWith: TEST_DOMAIN } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await systemDb.workspace.deleteMany({
    where: { OR: [{ memberships: { some: { userId: { in: ids } } } }, { name: { endsWith: " ws" } }, { slug: { startsWith: "itest-" } }] },
  });
  await systemDb.auditLog.deleteMany({ where: { actorId: { in: ids } } });
  await systemDb.user.deleteMany({ where: { id: { in: ids } } });
}
