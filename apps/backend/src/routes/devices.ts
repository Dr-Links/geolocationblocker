import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUser } from '../lib/db.js';
import { AppError, parse } from '../lib/errors.js';
import { summary } from './messages.js';
import type { Deps } from '../app.js';

const LIST_SELECT = `SELECT m.id, m.mailbox_id, mb.email_address AS mailbox_email, mb.display_name AS mailbox_name, mb.label_color,
       mb.status AS mailbox_status, m.thread_id, m.subject, m.from_address, m.from_name, m.to_summary, m.received_at, m.snippet,
       m.is_seen, m.is_flagged, m.is_answered, m.has_attachments, m.priority, m.has_pending_ops, m.server_state, m.security_flags
  FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id`;

const prefShape = z.object({
  newMail: z.boolean(), sendProblems: z.boolean(), mailboxProblems: z.boolean(), reminders: z.boolean(),
});

export function registerDeviceRoutes(app: FastifyInstance, deps: Deps) {
  const { db } = deps;
  const authed = { preHandler: app.authenticate };
  const active = { preHandler: [app.authenticate, app.requireActive] };
  const uidOf = (req: { auth?: { user: { id: string } } }) => req.auth!.user.id;

  /** Registers this device's push token (Expo push token or native FCM token). */
  app.put('/v1/devices/current/push', authed, async (req) => {
    const body = parse(z.object({
      token: z.string().min(10).max(4096),
      provider: z.enum(['expo', 'fcm']).default('expo'),
    }), req.body);
    if (body.provider === 'expo' && !/^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/.test(body.token)) {
      throw new AppError(400, 'validation_failed', 'Not an Expo push token.');
    }
    if (body.provider === 'fcm' && !/^[A-Za-z0-9_:-]{20,}$/.test(body.token)) throw new AppError(400, 'validation_failed', 'Not an FCM token.');
    const uid = uidOf(req);
    const ok = await withUser(db.api, uid, async (c) => {
      const { rows } = await c.query<{ device_id: string | null }>(`SELECT device_id FROM sessions WHERE id = $1`, [req.auth!.sessionId]);
      if (!rows[0]?.device_id) return false;
      const r = await c.query<{ ok: boolean }>(`SELECT app.assign_push_token($1, $2, $3) AS ok`, [rows[0].device_id, body.token, body.provider]);
      return r.rows[0]?.ok ?? false;
    });
    if (!ok) throw new AppError(409, 'conflict', 'This session has no device to attach notifications to. Sign in again.');
    return { ok: true };
  });

  app.delete('/v1/devices/current/push', authed, async (req, reply) => {
    await withUser(db.api, uidOf(req), (c) => c.query(
      `UPDATE devices SET push_token = NULL, push_enabled = false WHERE id = (SELECT device_id FROM sessions WHERE id = $1)`, [req.auth!.sessionId]));
    return reply.code(204).send();
  });

  app.get('/v1/notification-preferences', authed, async (req) => {
    const { rows } = await withUser(db.api, uidOf(req), (c) => c.query<{ mailbox_id: string | null; new_mail: boolean; send_problems: boolean; mailbox_problems: boolean; reminders: boolean }>(
      `SELECT mailbox_id, new_mail, send_problems, mailbox_problems, reminders FROM notification_preferences`));
    const d = rows.find((r) => r.mailbox_id === null);
    return {
      defaults: { newMail: d?.new_mail ?? true, sendProblems: d?.send_problems ?? true, mailboxProblems: d?.mailbox_problems ?? true, reminders: d?.reminders ?? true },
      mailboxes: rows.filter((r) => r.mailbox_id).map((r) => ({ mailboxId: r.mailbox_id, newMail: r.new_mail })),
    };
  });

  app.put('/v1/notification-preferences', authed, async (req) => {
    const body = parse(z.object({
      defaults: prefShape,
      mailboxes: z.array(z.object({ mailboxId: z.string().uuid(), newMail: z.boolean() })).max(100).default([]),
    }), req.body);
    const uid = uidOf(req);
    await withUser(db.api, uid, async (c) => {
      await c.query(`DELETE FROM notification_preferences`);
      const d = body.defaults;
      await c.query(`INSERT INTO notification_preferences (user_id, mailbox_id, new_mail, send_problems, mailbox_problems, reminders) VALUES ($1, NULL, $2, $3, $4, $5)`,
        [uid, d.newMail, d.sendProblems, d.mailboxProblems, d.reminders]);
      for (const m of body.mailboxes) {
        if (!(await c.query(`SELECT 1 FROM mailboxes WHERE id = $1`, [m.mailboxId])).rowCount) throw new AppError(404, 'not_found', 'Mailbox not found.');
        await c.query(`INSERT INTO notification_preferences (user_id, mailbox_id, new_mail, send_problems, mailbox_problems, reminders) VALUES ($1, $2, $3, $4, $5, $6)`,
          [uid, m.mailboxId, m.newMail, d.sendProblems, d.mailboxProblems, d.reminders]);
      }
    });
    return { ok: true };
  });

  /**
   * Multi-device sync: what changed since the device's last cursor. A device whose cursor is older than the
   * retained history (30 days) is told to reload everything instead of missing changes.
   */
  app.get('/v1/sync/changes', active, async (req) => {
    const q = parse(z.object({ since: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(1000).default(500) }), req.query);
    return withUser(db.api, uidOf(req), async (c) => {
      const { rows: bounds } = await c.query<{ min: number | null; max: number | null }>(`SELECT min(seq) AS min, max(seq) AS max FROM change_feed`);
      const max = bounds[0]?.max ?? 0;
      if (q.since > 0 && bounds[0]?.min && q.since < bounds[0].min - 1) {
        return { changes: [], cursor: max, hasMore: false, resetRequired: true };
      }
      if (q.since === 0) return { changes: [], cursor: max, hasMore: false, resetRequired: true };
      const { rows } = await c.query<{ seq: number; entity: string; entity_id: string; op: string }>(
        `SELECT seq, entity, entity_id, op FROM change_feed WHERE seq > $1 ORDER BY seq LIMIT $2`, [q.since, q.limit + 1]);
      const page = rows.slice(0, q.limit);
      return {
        changes: page.map((r) => ({ seq: r.seq, entity: r.entity, id: r.entity_id, op: r.op })),
        cursor: page.length ? page[page.length - 1]!.seq : Math.max(q.since, max),
        hasMore: rows.length > q.limit,
        resetRequired: false,
      };
    });
  });

  /** Message summaries by id (for applying a batch of changes on a device). */
  app.get('/v1/messages/batch', active, async (req) => {
    const q = parse(z.object({ ids: z.string().max(40 * 200) }), req.query);
    const ids = q.ids.split(',').filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 200);
    if (!ids.length) return { messages: [] };
    const { rows } = await withUser(db.api, uidOf(req), (c) => c.query(`${LIST_SELECT} WHERE m.id = ANY($1)`, [ids]));
    return { messages: rows.map((r) => summary(r as Parameters<typeof summary>[0])) };
  });
}
