import type { Tx } from './db.js';

export interface AuditEntry {
  actorType: 'admin' | 'user' | 'system';
  actorUserId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string | null;
  targetUserId?: string | null;
  ip?: string | null;
  /** IDs and settings only. Never passwords, tokens or email content. */
  details?: Record<string, unknown>;
}

export async function audit(c: Tx, e: AuditEntry): Promise<void> {
  await c.query(
    `INSERT INTO audit_log (actor_type, actor_user_id, action, target_type, target_id, target_user_id, ip, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.actorType, e.actorUserId ?? null, e.action, e.targetType ?? null, e.targetId ?? null,
     e.targetUserId ?? null, e.ip ?? null, JSON.stringify(e.details ?? {})],
  );
}
