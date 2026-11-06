import { Prisma } from "@prisma/client";
import { z } from "zod";
import { systemDb, withSystemTx } from "@/lib/db";
import { emailSchema } from "@/lib/validation/auth";
import { workspaceNameSchema } from "@/lib/validation/workspace";
import { NotFoundError } from "@/server/errors";
import { recordAudit } from "@/server/services/audit";
import { createInvitationTx, sendInvitationEmail } from "@/server/services/members";
import { uniqueWorkspaceSlug } from "@/server/services/workspaces";
import { getFreePlan } from "./entitlements";
import { compOverridesSchema, hasPaidAccess, type CompOverrides } from "./limits";
import { getBillingProvider } from "./providers";

/**
 * Comping = SUPER_ADMIN grants a workspace a plan's entitlements with no charge.
 *  - Full comp: the comp plan's limits/features as-is.
 *  - Partial comp: the comp plan plus per-limit/feature overrides
 *    (e.g. Free plan but 10 connected accounts and video enabled).
 * Comp is stored separately from the billed plan (compPlanId), so Stripe
 * webhooks never overwrite it, and removing it reverts cleanly.
 */

export const compInputSchema = z.object({
  planId: z.string().min(1, "Choose a plan"),
  overrides: compOverridesSchema.optional(),
  reason: z.string().trim().min(3, "A reason is required (shown in the audit log)").max(500),
  expiresAt: z.coerce.date().optional().nullable(),
  cancelPaidSubscription: z.boolean().default(false),
});
export type CompInput = z.input<typeof compInputSchema>;

function cleanOverrides(o: CompOverrides | undefined): CompOverrides | null {
  if (!o) return null;
  const limits = Object.fromEntries(Object.entries(o.limits ?? {}).filter(([, v]) => v !== undefined));
  const features = Object.fromEntries(Object.entries(o.features ?? {}).filter(([, v]) => v !== undefined));
  if (!Object.keys(limits).length && !Object.keys(features).length) return null;
  return { ...(Object.keys(limits).length ? { limits } : {}), ...(Object.keys(features).length ? { features } : {}) };
}

export async function compWorkspace(adminId: string, workspaceId: string, input: CompInput) {
  const data = compInputSchema.parse(input);
  if (data.expiresAt && data.expiresAt <= new Date()) throw new Error("Expiry must be in the future");
  const overrides = cleanOverrides(data.overrides);

  const result = await withSystemTx(async (tx) => {
    const ws = await tx.workspace.findUnique({ where: { id: workspaceId }, include: { subscription: true } });
    if (!ws) throw new NotFoundError("Workspace not found");
    const plan = await tx.plan.findUnique({ where: { id: data.planId } });
    if (!plan) throw new NotFoundError("Plan not found");

    const compFields = {
      isComped: true,
      compPlanId: plan.id,
      compOverrides: overrides ?? Prisma.DbNull,
      compReason: data.reason,
      compedById: adminId,
      compedAt: new Date(),
      compExpiresAt: data.expiresAt ?? null,
    };
    const sub = ws.subscription
      ? await tx.subscription.update({ where: { id: ws.subscription.id }, data: compFields })
      : await tx.subscription.create({ data: { workspaceId, planId: (await getFreePlan(tx)).id, ...compFields } });

    await recordAudit(
      {
        action: "admin.workspace.comp",
        actorId: adminId,
        workspaceId,
        targetType: "Subscription",
        targetId: sub.id,
        metadata: JSON.parse(JSON.stringify({ plan: plan.key, overrides, reason: data.reason, expiresAt: data.expiresAt, cancelPaid: data.cancelPaidSubscription })),
      },
      tx,
    );
    return { sub, hadPaid: ws.subscription ? hasPaidAccess(ws.subscription) : false };
  });

  // Stop charging a paying customer we just comped, if the admin asked to (at period end: they've paid for it).
  if (data.cancelPaidSubscription && result.hadPaid && result.sub.stripeSubscriptionId) {
    await getBillingProvider().cancelSubscription(result.sub.stripeSubscriptionId, { atPeriodEnd: true });
  }
  return result.sub;
}

export async function removeComp(adminId: string, workspaceId: string, reason?: string) {
  return withSystemTx(async (tx) => {
    const sub = await tx.subscription.findUnique({ where: { workspaceId } });
    if (!sub?.isComped) throw new NotFoundError("This workspace isn't comped");
    const updated = await tx.subscription.update({
      where: { id: sub.id },
      data: { isComped: false, compPlanId: null, compOverrides: Prisma.DbNull, compReason: null, compExpiresAt: null, compedAt: null, compedById: null },
    });
    await recordAudit(
      { action: "admin.workspace.uncomp", actorId: adminId, workspaceId, targetType: "Subscription", targetId: sub.id, metadata: { reason: reason ?? null, previousPlanId: sub.compPlanId } },
      tx,
    );
    return updated;
  });
}

export const createCompedAccountSchema = z.object({
  ownerEmail: emailSchema,
  workspaceName: workspaceNameSchema,
  planId: z.string().min(1),
  overrides: compOverridesSchema.optional(),
  reason: z.string().trim().min(3, "A reason is required").max(500),
  expiresAt: z.coerce.date().optional().nullable(),
});
export type CreateCompedAccountInput = z.input<typeof createCompedAccountSchema>;

/**
 * Create a free (comped) account in one step. If the owner already has a user
 * account they're added as WORKSPACE_ADMIN immediately; otherwise they get an
 * admin invitation link (shown to the SUPER_ADMIN, and emailed once email is set up).
 */
export async function createCompedAccount(adminId: string, input: CreateCompedAccountInput) {
  const data = createCompedAccountSchema.parse(input);
  const overrides = cleanOverrides(data.overrides);

  const res = await withSystemTx(async (tx) => {
    const plan = await tx.plan.findUnique({ where: { id: data.planId } });
    if (!plan) throw new NotFoundError("Plan not found");
    const free = await getFreePlan(tx);
    const owner = await tx.user.findUnique({ where: { email: data.ownerEmail } });

    const workspace = await tx.workspace.create({
      data: {
        name: data.workspaceName,
        slug: await uniqueWorkspaceSlug(tx, data.workspaceName),
        memberships: owner ? { create: { userId: owner.id, role: "WORKSPACE_ADMIN" } } : undefined,
        subscription: {
          create: {
            planId: free.id,
            isComped: true,
            compPlanId: plan.id,
            compOverrides: overrides ?? undefined,
            compReason: data.reason,
            compedById: adminId,
            compedAt: new Date(),
            compExpiresAt: data.expiresAt ?? null,
          },
        },
      },
    });

    const invite = owner
      ? null
      : await createInvitationTx(tx, { workspaceId: workspace.id, email: data.ownerEmail, role: "WORKSPACE_ADMIN", invitedById: adminId, enforceSeatLimit: false });

    await recordAudit(
      {
        action: "admin.account.create_comped",
        actorId: adminId,
        workspaceId: workspace.id,
        targetType: "Workspace",
        targetId: workspace.id,
        metadata: JSON.parse(JSON.stringify({ ownerEmail: data.ownerEmail, existingUser: !!owner, plan: plan.key, overrides, reason: data.reason, expiresAt: data.expiresAt })),
      },
      tx,
    );
    return { workspace, existingUser: !!owner, inviteUrl: invite?.url ?? null };
  });

  if (res.inviteUrl) {
    await sendInvitationEmail({ email: data.ownerEmail, workspaceName: res.workspace.name, role: "WORKSPACE_ADMIN", url: res.inviteUrl });
  }
  return res;
}

export async function getWorkspaceBillingForAdmin(workspaceId: string) {
  const ws = await systemDb.workspace.findUnique({
    where: { id: workspaceId },
    include: {
      subscription: { include: { plan: true, compPlan: true, compedBy: { select: { email: true, name: true } } } },
      memberships: { include: { user: { select: { email: true, name: true } } }, orderBy: { createdAt: "asc" } },
      _count: { select: { posts: true, socialAccounts: true } },
    },
  });
  if (!ws) throw new NotFoundError("Workspace not found");
  return ws;
}
