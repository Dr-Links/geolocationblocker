import { randomBytes } from "node:crypto";
import { withSystemTx, withTenantTx, type Tx } from "@/lib/db";
import { slugify } from "@/lib/utils";
import { createWorkspaceSchema, updateWorkspaceSchema } from "@/lib/validation/workspace";
import { assertCan } from "@/server/tenancy/guard";
import type { TenantContext } from "@/server/tenancy/types";
import { recordAudit } from "./audit";

/** Must run with bypass (slugs are globally unique across tenants). */
export async function uniqueWorkspaceSlug(tx: Tx, name: string) {
  const base = slugify(name) || "workspace";
  for (let i = 0; i < 5; i++) {
    const slug = i === 0 ? base : `${base}-${randomBytes(3).toString("hex")}`;
    if (!(await tx.workspace.findUnique({ where: { slug }, select: { id: true } }))) return slug;
  }
  return `${base}-${randomBytes(6).toString("hex")}`;
}

/**
 * Create a workspace with `userId` as WORKSPACE_ADMIN, on the free plan.
 * Pass `tx` (a system transaction) to compose with other writes, e.g. signup.
 */
export async function createWorkspaceForUser(
  userId: string,
  input: { name: string; timezone?: string },
  tx?: Tx,
) {
  const data = createWorkspaceSchema.parse(input);
  const run = async (t: Tx) => {
    const workspace = await t.workspace.create({
      data: {
        name: data.name,
        timezone: data.timezone,
        slug: await uniqueWorkspaceSlug(t, data.name),
        memberships: { create: { userId, role: "WORKSPACE_ADMIN" } },
      },
    });
    const freePlan = await t.plan.findUnique({ where: { key: "free" } });
    if (freePlan) await t.subscription.create({ data: { workspaceId: workspace.id, planId: freePlan.id } });
    await recordAudit(
      { action: "workspace.create", actorId: userId, workspaceId: workspace.id, targetType: "Workspace", targetId: workspace.id },
      t,
    );
    return workspace;
  };
  return tx ? run(tx) : withSystemTx(run);
}

export async function updateWorkspace(ctx: TenantContext, input: { name: string; timezone: string }) {
  assertCan(ctx, "workspace.update");
  const data = updateWorkspaceSchema.parse(input);
  return withTenantTx(ctx.workspaceId, async (tx) => {
    const before = await tx.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId } });
    const workspace = await tx.workspace.update({ where: { id: ctx.workspaceId }, data });
    await recordAudit(
      {
        action: "workspace.update",
        actorId: ctx.userId,
        workspaceId: ctx.workspaceId,
        targetType: "Workspace",
        targetId: ctx.workspaceId,
        metadata: { before: { name: before.name, timezone: before.timezone }, after: data },
      },
      tx,
    );
    return workspace;
  });
}
