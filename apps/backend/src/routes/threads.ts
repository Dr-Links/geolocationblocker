import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUser } from '../lib/db.js';
import { AppError, parse } from '../lib/errors.js';
import { summary } from './messages.js';
import type { Deps } from '../app.js';

const LIST_SELECT = `SELECT m.id, m.mailbox_id, mb.email_address AS mailbox_email, mb.display_name AS mailbox_name, mb.label_color,
       mb.status AS mailbox_status, m.thread_id, m.subject, m.from_address, m.from_name, m.to_summary, m.received_at, m.snippet,
       m.is_seen, m.is_flagged, m.is_answered, m.has_attachments, m.priority, m.has_pending_ops, m.server_state
  FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id`;

export function registerThreadRoutes(app: FastifyInstance, deps: Deps) {
  const { db } = deps;
  const active = { preHandler: [app.authenticate, app.requireActive] };
  const uidOf = (req: { auth?: { user: { id: string } } }) => req.auth!.user.id;

  /**
   * Conversation list: one row per thread that has at least one message in the chosen view, showing
   * its newest matching message plus counts across the whole conversation (all mailboxes).
   */
  app.get('/v1/threads', active, async (req) => {
    const q = parse(z.object({
      view: z.enum(['inbox', 'sent', 'folder', 'flagged']).default('inbox'),
      mailboxId: z.string().uuid().optional(),
      folderId: z.string().uuid().optional(),
      unread: z.enum(['1', '0']).optional(),
      before: z.string().max(80).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(30),
    }), req.query);
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where: string[] = [];
    if (q.view === 'folder') {
      if (!q.folderId) throw new AppError(400, 'validation_failed', 'folderId is required for view=folder.');
      where.push(`EXISTS (SELECT 1 FROM message_locations l WHERE l.message_id = m.id AND l.folder_id = ${p(q.folderId)})`);
    } else if (q.view === 'flagged') {
      where.push('m.is_flagged');
    } else {
      where.push(`EXISTS (SELECT 1 FROM message_locations l JOIN folders f ON f.id = l.folder_id WHERE l.message_id = m.id AND f.special_use = ${p(q.view)})`);
    }
    if (q.mailboxId) where.push(`m.mailbox_id = ${p(q.mailboxId)}`);
    if (q.unread === '1') where.push('NOT m.is_seen');
    let cursor = '';
    if (q.before) {
      const [ts, id] = q.before.split('|');
      if (!ts || !id || Number.isNaN(Date.parse(ts))) throw new AppError(400, 'validation_failed', 'Invalid cursor.');
      cursor = `WHERE (received_at, thread_id) < (${p(ts)}::timestamptz, ${p(id)}::uuid)`;
    }
    const { rows } = await withUser(db.api, uidOf(req), (c) => c.query<{ thread_id: string; latest_id: string; received_at: Date }>(
      `WITH latest AS (
         SELECT DISTINCT ON (m.thread_id) m.thread_id, m.id AS latest_id, m.received_at
           FROM messages m WHERE ${where.join(' AND ')}
          ORDER BY m.thread_id, m.received_at DESC, m.id DESC)
       SELECT * FROM latest ${cursor} ORDER BY received_at DESC, thread_id DESC LIMIT ${q.limit + 1}`, params));
    const page = rows.slice(0, q.limit);
    if (!page.length) return { threads: [], nextCursor: null };
    const details = await withUser(db.api, uidOf(req), async (c) => {
      const latest = await c.query(`${LIST_SELECT} WHERE m.id = ANY($1)`, [page.map((r) => r.latest_id)]);
      const stats = await c.query<{ thread_id: string; total: number; unread: number; flagged: boolean; attachments: boolean; mailboxes: string[]; participants: string[] }>(
        `SELECT m.thread_id, count(*)::int AS total, count(*) FILTER (WHERE NOT m.is_seen)::int AS unread, bool_or(m.is_flagged) AS flagged,
                bool_or(m.has_attachments) AS attachments, array_agg(DISTINCT mb.email_address) AS mailboxes,
                (array_agg(DISTINCT coalesce(nullif(m.from_name, ''), m.from_address)) FILTER (WHERE m.from_address IS NOT NULL))[1:4] AS participants
           FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE m.thread_id = ANY($1) GROUP BY m.thread_id`,
        [page.map((r) => r.thread_id)]);
      return { latest: new Map(latest.rows.map((r) => [(r as { id: string }).id, r])), stats: new Map(stats.rows.map((s) => [s.thread_id, s])) };
    });
    const last = page[page.length - 1]!;
    return {
      threads: page.map((r) => {
        const s = details.stats.get(r.thread_id)!;
        return {
          id: r.thread_id,
          latest: summary(details.latest.get(r.latest_id) as Parameters<typeof summary>[0]),
          messageCount: s.total,
          unreadCount: s.unread,
          isFlagged: s.flagged,
          hasAttachments: s.attachments,
          mailboxes: s.mailboxes,
          participants: s.participants ?? [],
        };
      }),
      nextCursor: rows.length > q.limit ? `${last.received_at.toISOString()}|${last.thread_id}` : null,
    };
  });

  /** All messages of a conversation, oldest first, each labelled with the mailbox that holds it. */
  app.get('/v1/threads/:id', active, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { rows } = await withUser(db.api, uidOf(req), (c) => c.query(`${LIST_SELECT} WHERE m.thread_id = $1 ORDER BY m.received_at, m.sent_at NULLS LAST, m.id`, [id]));
    if (!rows.length) throw new AppError(404, 'not_found', 'Conversation not found.');
    const messages = rows.map((r) => summary(r as Parameters<typeof summary>[0]));
    return { id, subject: messages[messages.length - 1]!.subject, messages, mailboxes: [...new Set(messages.map((m) => m.mailbox.email))] };
  });
}
