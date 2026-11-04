import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { withUser } from '../lib/db.js';
import { parse } from '../lib/errors.js';
import { storageStatus } from '../storage/quota.js';
import type { Deps } from '../app.js';

export function registerStorageRoutes(app: FastifyInstance, deps: Deps) {
  const { db } = deps;
  const authed = { preHandler: app.authenticate };
  const active = { preHandler: [app.authenticate, app.requireActive] };
  const uidOf = (req: { auth?: { user: { id: string } } }) => req.auth!.user.id;

  /** Usage, limit, and what is stored. Also available while suspended: the data is kept. */
  app.get('/v1/storage', authed, async (req) => {
    const uid = uidOf(req);
    return withUser(db.api, uid, async (c) => {
      const st = await storageStatus(c);
      const { rows } = await c.query<{ mailbox_id: string; email_address: string; messages: number; body_bytes: string; deleted_on_server: number }>(
        `SELECT mb.id AS mailbox_id, mb.email_address, count(m.id)::int AS messages, coalesce(sum(b.stored_bytes), 0) AS body_bytes,
                count(m.id) FILTER (WHERE m.server_state = 'deleted_on_server')::int AS deleted_on_server
           FROM mailboxes mb LEFT JOIN messages m ON m.mailbox_id = mb.id LEFT JOIN message_bodies b ON b.message_id = m.id
          GROUP BY mb.id ORDER BY mb.email_address`);
      return {
        storage: {
          ...st,
          mailboxes: rows.map((r) => ({ mailboxId: r.mailbox_id, email: r.email_address, messages: r.messages,
            textBytes: Number(r.body_bytes), deletedOnServer: r.deleted_on_server })),
        },
      };
    });
  });

  app.put('/v1/storage/settings', active, async (req) => {
    const body = parse(z.object({ bodyRetentionDays: z.number().int().min(7).max(3650).nullable() }), req.body);
    const uid = uidOf(req);
    return withUser(db.api, uid, async (c) => {
      await c.query(`INSERT INTO storage_preferences (user_id, body_retention_days) VALUES ($1, $2)
                     ON CONFLICT (user_id) DO UPDATE SET body_retention_days = EXCLUDED.body_retention_days, updated_at = now()`,
        [uid, body.bodyRetentionDays]);
      return { storage: await storageStatus(c) };
    });
  });

  /**
   * Frees space by removing the copies kept here of messages that were already deleted on the mail
   * server. These copies exist only on this platform, so the user must confirm.
   */
  app.post('/v1/storage/remove-deleted-on-server', active, async (req) => {
    const body = parse(z.object({ confirm: z.literal(true), mailboxId: z.string().uuid().optional() }), req.body);
    const uid = uidOf(req);
    return withUser(db.api, uid, async (c) => {
      const { rowCount } = await c.query(
        `DELETE FROM messages WHERE server_state = 'deleted_on_server' AND NOT is_draft AND ($1::uuid IS NULL OR mailbox_id = $1)
           AND NOT EXISTS (SELECT 1 FROM mailbox_operations o WHERE o.message_id = messages.id AND o.status = 'pending')`,
        [body.mailboxId ?? null]);
      await audit(c, { actorType: 'user', actorUserId: uid, action: 'storage.removed_deleted_on_server', targetType: 'user', targetId: uid,
        targetUserId: uid, ip: req.ip, details: { messages: rowCount ?? 0 } });
      return { removed: rowCount ?? 0, storage: await storageStatus(c) };
    });
  });
}
