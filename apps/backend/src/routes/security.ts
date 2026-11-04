import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { withUser } from '../lib/db.js';
import { AppError, parse } from '../lib/errors.js';
import { applyBlocklist } from '../security/blocklist.js';
import type { Deps } from '../app.js';
import { summary } from './messages.js';

/** "a@b.com" stays an address; "@b.com" or "b.com" means the whole domain. */
export function normalizePattern(raw: string): string {
  const s = raw.trim().toLowerCase();
  const p = s.includes('@') ? s : `@${s}`;
  if (!/^([^@\s]+@|@)[^@\s]+\.[^@\s]+$/.test(p) || p.length > 254) throw new AppError(400, 'validation_failed', 'Enter an email address (name@example.com) or a domain (example.com).');
  return p;
}

const LIST_SELECT = `SELECT m.id, m.mailbox_id, mb.email_address AS mailbox_email, mb.display_name AS mailbox_name, mb.label_color,
       mb.status AS mailbox_status, m.thread_id, m.subject, m.from_address, m.from_name, m.to_summary, m.received_at, m.snippet,
       m.is_seen, m.is_flagged, m.is_answered, m.has_attachments, m.priority, m.has_pending_ops, m.server_state, m.security_flags
  FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id`;

export function registerSecurityRoutes(app: FastifyInstance, deps: Deps) {
  const { db } = deps;
  const active = { preHandler: [app.authenticate, app.requireActive] };
  const uidOf = (req: { auth?: { user: { id: string } } }) => req.auth!.user.id;
  const idParam = z.object({ id: z.string().uuid() });

  app.get('/v1/blocked-senders', active, async (req) => withUser(db.api, uidOf(req), async (c) => {
    const { rows } = await c.query<{ pattern: string; created_at: Date }>(`SELECT pattern, created_at FROM blocked_senders ORDER BY pattern`);
    return { blocked: rows.map((r) => ({ pattern: r.pattern, createdAt: r.created_at.toISOString() })) };
  }));

  /** Block an address or domain. With messageId, that message (and future ones) goes to Junk. */
  app.post('/v1/blocked-senders', active, async (req) => {
    const body = parse(z.object({
      pattern: z.string().max(254).optional(),
      messageId: z.string().uuid().optional(),
      scope: z.enum(['address', 'domain']).default('address'),
    }), req.body);
    const uid = uidOf(req);
    return withUser(db.api, uid, async (c) => {
      let pattern: string;
      let msg: { id: string; mailbox_id: string; from_address: string | null; in_inbox: boolean } | undefined;
      if (body.messageId) {
        const { rows } = await c.query<{ id: string; mailbox_id: string; from_address: string | null; in_inbox: boolean }>(
          `SELECT m.id, m.mailbox_id, m.from_address, EXISTS (SELECT 1 FROM message_locations l JOIN folders f ON f.id = l.folder_id
                   WHERE l.message_id = m.id AND f.special_use = 'inbox') AS in_inbox
             FROM messages m WHERE m.id = $1`, [body.messageId]);
        msg = rows[0];
        if (!msg) throw new AppError(404, 'not_found', 'Message not found.');
        if (!msg.from_address) throw new AppError(400, 'validation_failed', 'This message has no sender address to block.');
        pattern = normalizePattern(body.scope === 'domain' ? `@${msg.from_address.split('@')[1]}` : msg.from_address);
      } else if (body.pattern) {
        pattern = normalizePattern(body.pattern);
      } else {
        throw new AppError(400, 'validation_failed', 'Enter an address or domain to block.');
      }
      const own = await c.query(`SELECT 1 FROM mailboxes WHERE lower(email_address) = $1 OR '@' || split_part(lower(email_address), '@', 2) = $1`, [pattern]);
      if (own.rowCount) throw new AppError(400, 'validation_failed', 'You cannot block one of your own mailboxes.');
      await c.query(`INSERT INTO blocked_senders (user_id, pattern) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [uid, pattern]);
      let moved = false;
      if (msg?.in_inbox) moved = !!(await applyBlocklist(c, uid, msg.mailbox_id, msg.id, msg.from_address));
      await audit(c, { actorType: 'user', actorUserId: uid, action: 'sender.blocked', targetType: 'user', targetId: uid, targetUserId: uid, ip: req.ip, details: { pattern } });
      return { pattern, movedToJunk: moved };
    });
  });

  app.delete('/v1/blocked-senders', active, async (req, reply) => {
    const q = parse(z.object({ pattern: z.string().max(254) }), req.query);
    await withUser(db.api, uidOf(req), (c) => c.query(`DELETE FROM blocked_senders WHERE pattern = $1`, [q.pattern.trim().toLowerCase()]));
    return reply.code(204).send();
  });

  // ---- Follow-up reminders -------------------------------------------------------------------------------

  app.put('/v1/messages/:id/reminder', active, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({
      remindAt: z.string().datetime({ offset: true }),
      onlyIfNoReply: z.boolean().default(false),
      note: z.string().max(500).nullable().optional(),
    }), req.body);
    const at = new Date(body.remindAt);
    if (at.getTime() < Date.now() + 60_000) throw new AppError(400, 'validation_failed', 'Choose a time at least one minute from now.');
    if (at.getTime() > Date.now() + 366 * 86_400_000) throw new AppError(400, 'validation_failed', 'Reminders can be set up to one year ahead.');
    const uid = uidOf(req);
    return withUser(db.api, uid, async (c) => {
      const m = await c.query(`SELECT 1 FROM messages WHERE id = $1`, [id]);
      if (!m.rowCount) throw new AppError(404, 'not_found', 'Message not found.');
      const { rows } = await c.query<{ id: string; remind_at: Date; only_if_no_reply: boolean; note: string | null; status: string }>(
        `INSERT INTO reminders (user_id, message_id, remind_at, only_if_no_reply, note) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (message_id) DO UPDATE SET remind_at = EXCLUDED.remind_at, only_if_no_reply = EXCLUDED.only_if_no_reply,
                note = EXCLUDED.note, status = 'pending', fired_at = NULL, created_at = now()
         RETURNING id, remind_at, only_if_no_reply, note, status`, [uid, id, at, body.onlyIfNoReply, body.note ?? null]);
      const r = rows[0]!;
      return { reminder: { id: r.id, messageId: id, remindAt: r.remind_at.toISOString(), onlyIfNoReply: r.only_if_no_reply, note: r.note, status: r.status } };
    });
  });

  app.delete('/v1/messages/:id/reminder', active, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    await withUser(db.api, uidOf(req), (c) => c.query(`DELETE FROM reminders WHERE message_id = $1`, [id]));
    return reply.code(204).send();
  });

  /** Upcoming reminders, and those that went off in the last 30 days. */
  app.get('/v1/reminders', active, async (req) => withUser(db.api, uidOf(req), async (c) => {
    const { rows } = await c.query<Record<string, unknown> & { r_id: string; remind_at: Date; only_if_no_reply: boolean; note: string | null; r_status: string; fired_at: Date | null }>(
      `SELECT x.*, r.id AS r_id, r.remind_at, r.only_if_no_reply, r.note, r.status AS r_status, r.fired_at
         FROM reminders r JOIN (${LIST_SELECT}) x ON x.id = r.message_id
        WHERE r.status = 'pending' OR (r.status IN ('fired','replied') AND r.fired_at > now() - interval '30 days')
        ORDER BY (r.status = 'pending') ASC, r.remind_at ASC LIMIT 200`);
    return {
      reminders: rows.map((r) => ({
        id: r.r_id, remindAt: r.remind_at.toISOString(), onlyIfNoReply: r.only_if_no_reply, note: r.note, status: r.r_status,
        firedAt: r.fired_at?.toISOString() ?? null, message: summary(r as unknown as Parameters<typeof summary>[0]),
      })),
    };
  }));
}
