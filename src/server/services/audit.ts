import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

type Tx = PrismaClient | Prisma.TransactionClient;

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

export async function recordAudit(entry: AuditEntry, tx: Tx = db) {
  await tx.auditLog.create({ data: { ...entry, metadata: entry.metadata ?? {} } });
  logger.info({ audit: entry.action, actorId: entry.actorId, workspaceId: entry.workspaceId }, "audit");
}
