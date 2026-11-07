import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { systemDb, withSystemTx } from "@/lib/db";
import { isCompActive, hasPaidAccess } from "@/server/billing/limits";
import { ConflictError, NotFoundError } from "@/server/errors";
import { recordAudit } from "@/server/services/audit";
import { clearImpersonationCookie, impersonationReasonSchema, setImpersonationCookie } from "@/server/tenancy/impersonation";

/** SUPER_ADMIN platform management. Every mutation is audited with the acting admin. */

export const PAGE_SIZE = 25;
const pageOf = (p: unknown) => Math.max(1, Math.min(10_000, Number(p) || 1));

// ─── Workspaces ────────────────────────────────────────────────────────────

export type WorkspaceFilter = "all" | "paying" | "comped" | "free" | "suspended";

export async function listWorkspaces(opts: { q?: string; filter?: WorkspaceFilter; page?: unknown }) {
  const page = pageOf(opts.page);
  const q = opts.q?.trim().slice(0, 100);
  const now = new Date();
  const where: Prisma.WorkspaceWhereInput = {
    ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { slug: { contains: q, mode: "insensitive" } }, { memberships: { some: { user: { email: { contains: q, mode: "insensitive" } } } } }] } : {}),
    ...(opts.filter === "suspended" ? { suspendedAt: { not: null } } : {}),
    ...(opts.filter === "comped" ? { subscription: { isComped: true, OR: [{ compExpiresAt: null }, { compExpiresAt: { gt: now } }] } } : {}),
    ...(opts.filter === "paying" ? { subscription: { stripeSubscriptionId: { not: null }, status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } } } : {}),
    ...(opts.filter === "free"
      ? { OR: [{ subscription: null }, { subscription: { AND: [{ OR: [{ isComped: false }, { compExpiresAt: { lte: now } }] }, { OR: [{ stripeSubscriptionId: null }, { status: { notIn: ["ACTIVE", "TRIALING", "PAST_DUE"] } }] }] } }] }
      : {}),
  };
  const [total, rows] = await Promise.all([
    systemDb.workspace.count({ where }),
    systemDb.workspace.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { subscription: { include: { plan: true, compPlan: true } }, _count: { select: { memberships: true, posts: true, socialAccounts: true } } },
    }),
  ]);
  return {
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    rows: rows.map((w) => {
      const s = w.subscription;
      const comp = s ? isCompActive(s, now) : false;
      const paid = s ? hasPaidAccess(s) : false;
      return { ...w, planLabel: comp ? (s!.compPlan?.name ?? s!.plan.name) : paid ? s!.plan.name : "Free", source: comp ? "comped" : paid ? (s!.status === "PAST_DUE" ? "past due" : "paying") : "free" };
    }),
  };
}

export async function setWorkspaceSuspended(adminId: string, workspaceId: string, suspend: boolean, reason?: string) {
  if (suspend) z.string().trim().min(3, "Give a reason").parse(reason ?? "");
  return withSystemTx(async (tx) => {
    const ws = await tx.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw new NotFoundError("Workspace not found");
    if (!!ws.suspendedAt === suspend) throw new ConflictError(suspend ? "Already suspended" : "Not suspended");
    await tx.workspace.update({ where: { id: workspaceId }, data: { suspendedAt: suspend ? new Date() : null } });
    await recordAudit({ action: suspend ? "admin.workspace.suspend" : "admin.workspace.unsuspend", actorId: adminId, workspaceId, targetType: "Workspace", targetId: workspaceId, metadata: { reason: reason ?? null } }, tx);
  });
}

export async function startImpersonation(adminId: string, workspaceId: string, reason: string) {
  const r = impersonationReasonSchema.parse(reason);
  const ws = await systemDb.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true } });
  if (!ws) throw new NotFoundError("Workspace not found");
  await setImpersonationCookie(adminId, ws.id, r);
  await recordAudit({ action: "admin.impersonation.start", actorId: adminId, impersonatorId: adminId, workspaceId: ws.id, targetType: "Workspace", targetId: ws.id, metadata: { reason: r } });
  return ws;
}

export async function stopImpersonation(adminId: string, workspaceId: string | null) {
  await clearImpersonationCookie();
  await recordAudit({ action: "admin.impersonation.stop", actorId: adminId, impersonatorId: adminId, workspaceId, targetType: "Workspace", targetId: workspaceId ?? undefined });
}

// ─── Users ─────────────────────────────────────────────────────────────────

export async function listUsers(opts: { q?: string; filter?: "all" | "admins" | "disabled"; page?: unknown }) {
  const page = pageOf(opts.page);
  const q = opts.q?.trim().slice(0, 100);
  const where: Prisma.UserWhereInput = {
    ...(q ? { OR: [{ email: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] } : {}),
    ...(opts.filter === "admins" ? { platformRole: "SUPER_ADMIN" } : {}),
    ...(opts.filter === "disabled" ? { disabledAt: { not: null } } : {}),
  };
  const [total, rows] = await Promise.all([
    systemDb.user.count({ where }),
    systemDb.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: { id: true, email: true, name: true, platformRole: true, disabledAt: true, createdAt: true, lastLoginAt: true, _count: { select: { memberships: true } } },
    }),
  ]);
  return { total, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), rows };
}

export async function getUserForAdmin(userId: string) {
  const user = await systemDb.user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, name: true, platformRole: true, disabledAt: true, createdAt: true, lastLoginAt: true, sessionVersion: true,
      accounts: { select: { provider: true } },
      memberships: { orderBy: { createdAt: "asc" }, select: { role: true, createdAt: true, workspace: { select: { id: true, name: true, suspendedAt: true } } } },
    },
  });
  if (!user) throw new NotFoundError("User not found");
  return user;
}

async function assertNotLastActiveAdmin(tx: Prisma.TransactionClient, userId: string) {
  const others = await tx.user.count({ where: { platformRole: "SUPER_ADMIN", disabledAt: null, id: { not: userId } } });
  if (others === 0) throw new ConflictError("This is the last active SUPER_ADMIN. Promote someone else first.");
}

export async function setUserDisabled(adminId: string, userId: string, disable: boolean, reason?: string) {
  if (adminId === userId) throw new ConflictError("You can't disable your own account.");
  return withSystemTx(async (tx) => {
    const u = await tx.user.findUnique({ where: { id: userId } });
    if (!u) throw new NotFoundError("User not found");
    if (disable && u.platformRole === "SUPER_ADMIN") await assertNotLastActiveAdmin(tx, userId);
    // Disabling also revokes every live session (sessionVersion bump).
    await tx.user.update({ where: { id: userId }, data: disable ? { disabledAt: new Date(), sessionVersion: { increment: 1 } } : { disabledAt: null } });
    await recordAudit({ action: disable ? "admin.user.disable" : "admin.user.enable", actorId: adminId, targetType: "User", targetId: userId, metadata: { email: u.email, reason: reason ?? null } }, tx);
  });
}

export async function forceSignOut(adminId: string, userId: string) {
  return withSystemTx(async (tx) => {
    const u = await tx.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } }).catch(() => null);
    if (!u) throw new NotFoundError("User not found");
    await recordAudit({ action: "admin.user.force_sign_out", actorId: adminId, targetType: "User", targetId: userId, metadata: { email: u.email } }, tx);
  });
}

export async function setPlatformRole(adminId: string, userId: string, role: "USER" | "SUPER_ADMIN") {
  if (adminId === userId && role !== "SUPER_ADMIN") throw new ConflictError("You can't remove your own SUPER_ADMIN role.");
  return withSystemTx(async (tx) => {
    const u = await tx.user.findUnique({ where: { id: userId } });
    if (!u) throw new NotFoundError("User not found");
    if (u.platformRole === role) return;
    if (role === "USER") await assertNotLastActiveAdmin(tx, userId);
    // Role changes take effect immediately: bump sessionVersion so the JWT's cached role can't linger.
    await tx.user.update({ where: { id: userId }, data: { platformRole: role, sessionVersion: { increment: 1 } } });
    await recordAudit({ action: role === "SUPER_ADMIN" ? "admin.user.grant_super_admin" : "admin.user.revoke_super_admin", actorId: adminId, targetType: "User", targetId: userId, metadata: { email: u.email } }, tx);
  });
}

// ─── Audit log ─────────────────────────────────────────────────────────────

export interface AuditQuery {
  action?: string;
  actor?: string; // email substring
  workspaceId?: string;
  from?: string; // YYYY-MM-DD
  to?: string;
  impersonatedOnly?: boolean;
  page?: unknown;
}

export async function queryAudit(q: AuditQuery) {
  const page = pageOf(q.page);
  const day = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : undefined);
  const from = day(q.from);
  const toDay = day(q.to);
  const to = toDay ? new Date(toDay.getTime() + 86_400_000) : undefined;
  const where: Prisma.AuditLogWhereInput = {
    ...(q.action?.trim() ? { action: { contains: q.action.trim().slice(0, 80) } } : {}),
    ...(q.actor?.trim() ? { actor: { email: { contains: q.actor.trim().slice(0, 100), mode: "insensitive" } } } : {}),
    ...(q.workspaceId?.trim() ? { workspaceId: q.workspaceId.trim() } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
    ...(q.impersonatedOnly ? { impersonatorId: { not: null } } : {}),
  };
  const [total, rows] = await Promise.all([
    systemDb.auditLog.count({ where }),
    systemDb.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * 50,
      take: 50,
      include: { actor: { select: { email: true } }, impersonator: { select: { email: true } }, workspace: { select: { id: true, name: true } } },
    }),
  ]);
  return { total, page, pages: Math.max(1, Math.ceil(total / 50)), rows };
}
