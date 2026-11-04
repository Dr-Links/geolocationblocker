import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUser } from '../lib/db.js';
import { AppError, parse } from '../lib/errors.js';
import { fetchBody, toIncoming } from '../sync/engine.js';
import type { StructureNode } from '../sync/parse.js';
import { storeMessage } from '../sync/store.js';
import { withImap } from '../sync/live.js';
import { summary } from './messages.js';
import type { Deps } from '../app.js';

const LIST_SELECT = `SELECT m.id, m.mailbox_id, mb.email_address AS mailbox_email, mb.display_name AS mailbox_name, mb.label_color,
       mb.status AS mailbox_status, m.thread_id, m.subject, m.from_address, m.from_name, m.to_summary, m.received_at, m.snippet,
       m.is_seen, m.is_flagged, m.is_answered, m.has_attachments, m.priority, m.has_pending_ops, m.server_state
  FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id`;

export const searchQuery = z.object({
  q: z.string().max(200).optional(),
  from: z.string().max(200).optional(),
  to: z.string().max(200).optional(),
  subject: z.string().max(200).optional(),
  mailboxId: z.string().uuid().optional(),
  in: z.enum(['any', 'inbox', 'sent', 'archive', 'trash', 'junk', 'drafts']).default('any'),
  unread: z.enum(['1', '0']).optional(),
  flagged: z.enum(['1', '0']).optional(),
  hasAttachments: z.enum(['1', '0']).optional(),
  dateFrom: z.string().max(40).optional(),
  dateTo: z.string().max(40).optional(),
});
export type SearchQuery = z.infer<typeof searchQuery>;

const like = (s: string) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

/** Turns free text into a safe prefix query: "quot 1042" → 'quot:* & 1042:*'. */
export function toTsQuery(q: string): string | null {
  const tokens = q.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0).slice(0, 10);
  return tokens.length ? tokens.map((t) => `${t}:*`).join(' & ') : null;
}

/** Builds the WHERE clause for a search. Always scoped to the current user by Row-Level Security. */
export function searchWhere(q: SearchQuery, params: unknown[]): string[] {
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where: string[] = ['true'];
  const ts = q.q ? toTsQuery(q.q) : null;
  if (q.q && !ts) throw new AppError(400, 'validation_failed', 'Enter words to search for.');
  if (ts) where.push(`m.search_vector @@ to_tsquery('simple', ${p(ts)})`);
  if (q.from) {
    where.push(`EXISTS (SELECT 1 FROM message_addresses a WHERE a.message_id = m.id AND a.kind = 'from' AND (a.address ILIKE ${p(like(q.from))} OR a.name ILIKE ${p(like(q.from))}))`);
  }
  if (q.to) {
    where.push(`EXISTS (SELECT 1 FROM message_addresses a WHERE a.message_id = m.id AND a.kind IN ('to','cc','bcc') AND (a.address ILIKE ${p(like(q.to))} OR a.name ILIKE ${p(like(q.to))}))`);
  }
  if (q.subject) where.push(`m.subject ILIKE ${p(like(q.subject))}`);
  if (q.mailboxId) where.push(`m.mailbox_id = ${p(q.mailboxId)}`);
  if (q.in !== 'any') {
    where.push(`EXISTS (SELECT 1 FROM message_locations l JOIN folders f ON f.id = l.folder_id WHERE l.message_id = m.id AND f.special_use = ${p(q.in)})`);
  }
  if (q.unread === '1') where.push('NOT m.is_seen');
  if (q.unread === '0') where.push('m.is_seen');
  if (q.flagged === '1') where.push('m.is_flagged');
  if (q.hasAttachments === '1') where.push('m.has_attachments');
  for (const [key, op] of [['dateFrom', '>='], ['dateTo', '<']] as const) {
    const v = q[key];
    if (!v) continue;
    if (Number.isNaN(Date.parse(v))) throw new AppError(400, 'validation_failed', `Invalid date: ${v}`);
    where.push(`m.received_at ${op} ${p(v)}::timestamptz`);
  }
  return where;
}

export function registerSearchRoutes(app: FastifyInstance, deps: Deps) {
  const { cfg, db } = deps;
  const active = { preHandler: [app.authenticate, app.requireActive] };
  const uidOf = (req: { auth?: { user: { id: string } } }) => req.auth!.user.id;

  app.get('/v1/search', { ...active, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const q = parse(searchQuery.extend({ before: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
    const params: unknown[] = [];
    const where = searchWhere(q, params);
    if (q.before) {
      const [ts, id] = q.before.split('|');
      if (!ts || !id || Number.isNaN(Date.parse(ts))) throw new AppError(400, 'validation_failed', 'Invalid cursor.');
      params.push(ts, id);
      where.push(`(m.received_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    const { rows } = await withUser(db.api, uidOf(req), (c) => c.query(
      `${LIST_SELECT} WHERE ${where.join(' AND ')} ORDER BY m.received_at DESC, m.id DESC LIMIT ${q.limit + 1}`, params));
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1] as { received_at: Date; id: string } | undefined;
    return {
      results: page.map((r) => summary(r as Parameters<typeof summary>[0])),
      nextCursor: rows.length > q.limit && last ? `${last.received_at.toISOString()}|${last.id}` : null,
      note: 'Searches the copies stored on this platform (by default the last 90 days of each mailbox). Use "Search on server" for older mail.',
    };
  });

  // Saved searches -----------------------------------------------------------
  app.get('/v1/saved-searches', active, async (req) => {
    const { rows } = await withUser(db.api, uidOf(req), (c) => c.query<{ id: string; name: string; query: unknown; created_at: Date }>(
      `SELECT id, name, query, created_at FROM saved_searches ORDER BY name`));
    return { savedSearches: rows.map((r) => ({ id: r.id, name: r.name, query: r.query, createdAt: r.created_at.toISOString() })) };
  });

  app.post('/v1/saved-searches', active, async (req, reply) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(80), query: searchQuery }), req.body);
    const uid = uidOf(req);
    try {
      const { rows } = await withUser(db.api, uid, (c) => c.query<{ id: string }>(
        `INSERT INTO saved_searches (user_id, name, query) VALUES ($1, $2, $3) RETURNING id`, [uid, body.name, JSON.stringify(body.query)]));
      return reply.code(201).send({ id: rows[0]!.id });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(409, 'conflict', 'A saved search with this name already exists.');
      throw err;
    }
  });

  app.delete('/v1/saved-searches/:id', active, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const r = await withUser(db.api, uidOf(req), (c) => c.query(`DELETE FROM saved_searches WHERE id = $1`, [id]));
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Saved search not found.');
    return reply.code(204).send();
  });

  /**
   * Searches older mail directly on the mail server (outside the sync window) and imports up to 30 of the
   * newest matches so they appear in normal search and can be opened.
   */
  app.post('/v1/mailboxes/:id/server-search', { ...active, config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({ q: z.string().trim().min(2).max(200) }), req.body);
    const uid = uidOf(req);
    const folders = await withUser(db.api, uid, (c) => c.query<{ id: string; path: string }>(
      `SELECT id, path FROM folders WHERE mailbox_id = $1 AND exists_on_server AND selectable
          AND (special_use IN ('inbox','sent','archive') OR special_use IS NULL) ORDER BY special_use NULLS LAST LIMIT 20`, [id]));
    if (!folders.rowCount) throw new AppError(404, 'not_found', 'Mailbox not found or not synced yet.');
    let imported = 0;
    let found = 0;
    await withImap(cfg, db.api, uid, id, async (client) => {
      for (const f of folders.rows) {
        if (imported >= 30) break;
        const lock = await client.getMailboxLock(f.path, { readOnly: true });
        try {
          const box = client.mailbox;
          if (!box || !box.exists) continue;
          const uids = ((await client.search({ text: body.q }, { uid: true })) || []).sort((a, b) => b - a);
          found += uids.length;
          const known = await withUser(db.api, uid, (c) => c.query<{ uid: string }>(
            `SELECT uid FROM message_locations WHERE folder_id = $1 AND uid = ANY($2)`, [f.id, uids.slice(0, 200)]));
          const knownSet = new Set(known.rows.map((r) => Number(r.uid)));
          const todo = uids.filter((u) => !knownSet.has(u)).slice(0, 30 - imported);
          if (!todo.length) continue;
          // Read all results first: ImapFlow cannot run another command (the body fetch) while a FETCH is still streaming.
          const fetched = [];
          for await (const msg of client.fetch(todo.join(','), {
            uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true, emailId: true,
            headers: ['references', 'x-priority', 'importance', 'priority', 'authentication-results'],
          }, { uid: true })) fetched.push(msg);
          for (const msg of fetched) {
            const incoming = toIncoming(msg, f.id, Number(box.uidValidity));
            incoming.body = await fetchBody(client, msg.uid, msg.size ?? null, msg.bodyStructure as StructureNode | undefined).catch(() => null);
            const r = await withUser(db.api, uid, (c) => storeMessage(c, uid, id, f.id, msg.uid, incoming));
            if (r.created) imported++;
          }
        } finally {
          lock.release();
        }
      }
    });
    return { foundOnServer: found, imported };
  });
}
