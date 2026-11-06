import { createHash, randomBytes } from "node:crypto";
import type { WorkspaceRole } from "@prisma/client";
import { systemDb, withSystemTx, withTenantTx, type Tx } from "@/lib/db";
import { inviteSchema, workspaceRoleSchema } from "@/lib/validation/workspace";
import { ConflictError, ForbiddenError, NotFoundError } from "@/server/errors";
import { getMailer } from "@/server/mail";
import { assertCan } from "@/server/tenancy/guard";
import type { TenantContext } from "@/server/tenancy/types";
import { assertWithinLimit } from "@/server/billing/entitlements";
import { recordAudit } from "./audit";

export const INVITE_TTL_DAYS = 7;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function inviteUrl(token: string) {
  return `${process.env.APP_URL ?? "http://localhost:3000"}/invite/${token}`;
}

// ─── Members ────────────────────────────────────────────────────────────────

export async function listMembers(ctx: TenantContext) {
  assertCan(ctx, "members.view");
  return ctx.db.membership.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { createdAt: "asc" },
    include: { user: { select: { id: true, name: true, email: true, image: true } } },
  });
}

async function assertNotLastAdmin(tx: Tx, workspaceId: string, membershipId: string) {
  const admins = await tx.membership.findMany({
    where: { workspaceId, role: "WORKSPACE_ADMIN" },
    select: { id: true },
  });
  if (admins.length === 1 && admins[0]!.id === membershipId) {
    throw new ConflictError("A workspace needs at least one admin. Promote someone else first.");
  }
}

export async function changeMemberRole(ctx: TenantContext, membershipId: string, role: WorkspaceRole) {
  assertCan(ctx, "members.manage");
  const newRole = workspaceRoleSchema.parse(role);
  return withTenantTx(ctx.workspaceId, async (tx) => {
    // RLS hides other tenants' memberships, so a foreign id is simply "not found".
    const m = await tx.membership.findUnique({ where: { id: membershipId } });
    if (!m) throw new NotFoundError("Member not found");
    if (m.role === newRole) return m;
    if (m.role === "WORKSPACE_ADMIN") await assertNotLastAdmin(tx, ctx.workspaceId, m.id);
    const updated = await tx.membership.update({ where: { id: m.id }, data: { role: newRole } });
    await recordAudit(
      {
        action: "member.role_change",
        actorId: ctx.userId,
        workspaceId: ctx.workspaceId,
        targetType: "Membership",
        targetId: m.id,
        metadata: { userId: m.userId, from: m.role, to: newRole },
      },
      tx,
    );
    return updated;
  });
}

/** Remove a member. Admins can remove anyone; anyone can remove themselves (leave). */
export async function removeMember(ctx: TenantContext, membershipId: string) {
  return withTenantTx(ctx.workspaceId, async (tx) => {
    const m = await tx.membership.findUnique({ where: { id: membershipId } });
    if (!m) throw new NotFoundError("Member not found");
    const isSelf = m.userId === ctx.userId;
    if (!isSelf) assertCan(ctx, "members.manage");
    if (m.role === "WORKSPACE_ADMIN") await assertNotLastAdmin(tx, ctx.workspaceId, m.id);
    await tx.membership.delete({ where: { id: m.id } });
    await recordAudit(
      {
        action: isSelf ? "member.leave" : "member.remove",
        actorId: ctx.userId,
        workspaceId: ctx.workspaceId,
        targetType: "Membership",
        targetId: m.id,
        metadata: { userId: m.userId, role: m.role },
      },
      tx,
    );
  });
}

// ─── Invitations ────────────────────────────────────────────────────────────

export async function listPendingInvitations(ctx: TenantContext) {
  assertCan(ctx, "members.view");
  return ctx.db.invitation.findMany({
    where: { workspaceId: ctx.workspaceId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    include: { invitedBy: { select: { name: true, email: true } } },
  });
}

/**
 * Low-level: create (or re-issue) an invitation inside an existing transaction.
 * Re-inviting the same email revokes the previous pending invite.
 * Returns the one-time token; only its SHA-256 hash is stored.
 */
export async function createInvitationTx(
  tx: Tx,
  args: { workspaceId: string; email: string; role: WorkspaceRole; invitedById: string | null; enforceSeatLimit?: boolean },
) {
  const existingMember = await tx.membership.findFirst({
    where: { workspaceId: args.workspaceId, user: { email: args.email } },
    select: { id: true },
  });
  if (existingMember) throw new ConflictError("That person is already a member of this workspace");

  const revoked = await tx.invitation.updateMany({
    where: { workspaceId: args.workspaceId, email: args.email, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  // Pending invites reserve seats. Re-inviting the same person doesn't need a new seat.
  if (args.enforceSeatLimit !== false && revoked.count === 0) {
    await assertWithinLimit(tx, args.workspaceId, "maxMembers");
  }

  const token = randomBytes(32).toString("base64url");
  const invitation = await tx.invitation.create({
    data: {
      workspaceId: args.workspaceId,
      email: args.email,
      role: args.role,
      tokenHash: hashToken(token),
      invitedById: args.invitedById,
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
    },
    include: { workspace: { select: { name: true } } },
  });
  return { invitation, token, url: inviteUrl(token) };
}

export async function sendInvitationEmail(args: { email: string; workspaceName: string; role: WorkspaceRole; url: string }) {
  await getMailer().send({
    to: args.email,
    subject: `You're invited to ${args.workspaceName} on Postpilot`,
    text: `You've been invited to join ${args.workspaceName} as ${args.role === "WORKSPACE_ADMIN" ? "an admin" : "a member"}.\n\nAccept: ${args.url}\n\nThis link expires in ${INVITE_TTL_DAYS} days.`,
  });
}

/** Invite an email to the workspace (workspace admin action). */
export async function createInvitation(ctx: TenantContext, input: { email: string; role?: WorkspaceRole }) {
  assertCan(ctx, "members.manage");
  const { email, role } = inviteSchema.parse(input);

  const { invitation, url } = await withTenantTx(ctx.workspaceId, async (tx) => {
    const res = await createInvitationTx(tx, { workspaceId: ctx.workspaceId, email, role, invitedById: ctx.userId });
    await recordAudit(
      { action: "invitation.create", actorId: ctx.userId, workspaceId: ctx.workspaceId, targetType: "Invitation", targetId: res.invitation.id, metadata: { email, role } },
      tx,
    );
    return res;
  });

  await sendInvitationEmail({ email, workspaceName: invitation.workspace.name, role, url });
  return { invitation, url };
}

export async function revokeInvitation(ctx: TenantContext, invitationId: string) {
  assertCan(ctx, "members.manage");
  return withTenantTx(ctx.workspaceId, async (tx) => {
    const inv = await tx.invitation.findUnique({ where: { id: invitationId } });
    if (!inv || inv.acceptedAt || inv.revokedAt) throw new NotFoundError("Invitation not found");
    await tx.invitation.update({ where: { id: inv.id }, data: { revokedAt: new Date() } });
    await recordAudit(
      { action: "invitation.revoke", actorId: ctx.userId, workspaceId: ctx.workspaceId, targetType: "Invitation", targetId: inv.id },
      tx,
    );
  });
}

/**
 * Look up an invitation by its secret token, for the public /invite page.
 * System read: the visitor has no tenant context yet; the token is the authorization.
 */
export async function getInvitationByToken(token: string) {
  if (!token || token.length > 128) return null;
  const inv = await systemDb.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { workspace: { select: { id: true, name: true } }, invitedBy: { select: { name: true, email: true } } },
  });
  if (!inv) return null;
  const state = inv.acceptedAt ? "accepted" : inv.revokedAt ? "revoked" : inv.expiresAt < new Date() ? "expired" : "pending";
  return { ...inv, state } as const;
}

/**
 * Accept an invitation inside an existing SYSTEM transaction.
 * The invite's email must match the accepting user's email.
 */
export async function acceptInvitationTx(tx: Tx, args: { userId: string; email: string; token: string }) {
  const inv = await tx.invitation.findUnique({
    where: { tokenHash: hashToken(args.token) },
    include: { workspace: true },
  });
  if (!inv || inv.revokedAt || inv.acceptedAt || inv.expiresAt < new Date()) {
    throw new NotFoundError("This invitation is invalid or has expired");
  }
  if (inv.email.toLowerCase() !== args.email.toLowerCase()) {
    throw new ForbiddenError(`This invitation was sent to ${inv.email}. Sign in with that email to accept it.`);
  }

  // Mark accepted first, conditionally, so two concurrent accepts can't both win.
  const claimed = await tx.invitation.updateMany({
    where: { id: inv.id, acceptedAt: null, revokedAt: null },
    data: { acceptedAt: new Date() },
  });
  if (claimed.count !== 1) throw new NotFoundError("This invitation is invalid or has expired");

  const alreadyMember = await tx.membership.findUnique({
    where: { userId_workspaceId: { userId: args.userId, workspaceId: inv.workspaceId } },
  });
  if (!alreadyMember) {
    // The invite already reserved a seat; re-check members only, in case the plan was downgraded since.
    await assertWithinLimit(tx, inv.workspaceId, "maxMembers", { countPendingInvites: false });
    await tx.membership.create({ data: { userId: args.userId, workspaceId: inv.workspaceId, role: inv.role } });
  }
  await recordAudit(
    { action: "invitation.accept", actorId: args.userId, workspaceId: inv.workspaceId, targetType: "Invitation", targetId: inv.id },
    tx,
  );
  return inv.workspace;
}

export function acceptInvitation(args: { userId: string; email: string; token: string }) {
  return withSystemTx((tx) => acceptInvitationTx(tx, args));
}
