import type { Prisma } from "@prisma/client";
import { systemDb, type Tx } from "@/lib/db";
import { logger } from "@/lib/logger";

export interface AuditEntry {
  action: string;
  actorId?: string | null;
  impersonatorId?: string | null;
  workspaceId?: string | null;
  targetType?: string;
  targetId?: string;
  metadata?: Prisma.InputJsonValue;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Append an audit row. Pass the surrounding transaction so the audit entry
 * commits/rolls back with the change it describes. Without a tx it writes via
 * systemDb (audit rows may be platform-level, with no workspace).
 */
export async function recordAudit(entry: AuditEntry, tx?: Tx) {
  const data = { ...entry, metadata: entry.metadata ?? {} };
  if (tx) await tx.auditLog.create({ data });
  else await systemDb.auditLog.create({ data });
  logger.info({ audit: entry.action, actorId: entry.actorId, workspaceId: entry.workspaceId, targetId: entry.targetId }, "audit");
}

/** Actor fields for an audit entry made inside a tenant context (records the impersonating admin too). */
export function auditActor(ctx: { userId: string; workspaceId: string; impersonatorId?: string | null }) {
  return { actorId: ctx.userId, workspaceId: ctx.workspaceId, impersonatorId: ctx.impersonatorId ?? null };
}
