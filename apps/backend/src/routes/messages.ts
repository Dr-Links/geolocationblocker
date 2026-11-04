import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUser, type Tx } from '../lib/db.js';
import { AppError, parse } from '../lib/errors.js';
import { fetchBody } from '../sync/engine.js';
import { processOperations, type OperationPayload } from '../sync/operations.js';
import { blockRemoteImages, type StructureNode } from '../sync/parse.js';
import { storeBody } from '../sync/store.js';
import { withImap } from '../sync/live.js';
import type { Deps } from '../app.js';

const idParam = z.object({ id: z.string().uuid() });

interface ListRow {
  id: string; mailbox_id: string; mailbox_email: string; mailbox_name: string | null; label_color: string | null; mailbox_status: string;
  thread_id: string; subject: string | null; from_address: string | null; from_name: string | null; to_summary: string | null;
  received_at: Date; snippet: string | null; is_seen: boolean; is_flagged: boolean; is_answered: boolean; has_attachments: boolean;
  priority: string; has_pending_ops: boolean; server_state: string;
}

const LIST_SELECT = `SELECT m.id, m.mailbox_id, mb.email_address AS mailbox_email, mb.display_name AS mailbox_name, mb.label_color,
       mb.status AS mailbox_status, m.thread_id, m.subject, m.from_address, m.from_name, m.to_summary, m.received_at, m.snippet,
       m.is_seen, m.is_flagged, m.is_answered, m.has_attachments, m.priority, m.has_pending_ops, m.server_state
  FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id`;

export const summary = (r: ListRow) => ({
  id: r.id,
  mailbox: { id: r.mailbox_id, email: r.mailbox_email, displayName: r.mailbox_name, labelColor: r.label_color, status: r.mailbox_status },
  threadId: r.thread_id,
  subject: r.subject,
  from: r.from_address ? { address: r.from_address, name: r.from_name } : null,
  toSummary: r.to_summary,
  receivedAt: r.received_at.toISOString(),
  snippet: r.snippet,
  isSeen: r.is_seen,
  isFlagged: r.is_flagged,
  isAnswered: r.is_answered,
  hasAttachments: r.has_attachments,
  priority: r.priority,
  pendingSync: r.has_pending_ops,
  onServer: r.server_state === 'present',
});

async function loadSummary(c: Tx, id: string) {
  const { rows } = await c.query<ListRow>(`${LIST_SELECT} WHERE m.id = $1`, [id]);
  return rows[0] ? summary(rows[0]) : null;
}

export function registerMessageRoutes(app: FastifyInstance, deps: Deps) {
  const { cfg, db } = deps;
  const active = { preHandler: [app.authenticate, app.requireActive] };
  const uidOf = (req: { auth?: { user: { id: string } } }) => req.auth!.user.id;

  app.get('/v1/mailboxes/:id/folders', active, async (req) => {
    const { id } = parse(idParam, req.params);
    return withUser(db.api, uidOf(req), async (c) => {
      const mb = await c.query(`SELECT 1 FROM mailboxes WHERE id = $1`, [id]);
      if (!mb.rowCount) throw new AppError(404, 'not_found', 'Mailbox not found.');
      const { rows } = await c.query<{ id: string; path: string; display_name: string; special_use: string | null; server_count: number;
                                       unread: number; stored: number; last_synced_at: Date | null; initial_done: boolean; selectable: boolean }>(
        `SELECT f.id, f.path, f.display_name, f.special_use, f.server_count, f.last_synced_at, f.initial_done, f.selectable,
                count(m.id) FILTER (WHERE NOT m.is_seen)::int AS unread, count(m.id)::int AS stored
           FROM folders f LEFT JOIN message_locations l ON l.folder_id = f.id LEFT JOIN messages m ON m.id = l.message_id
          WHERE f.mailbox_id = $1 AND f.exists_on_server
          GROUP BY f.id
          ORDER BY CASE f.special_use WHEN 'inbox' THEN 0 WHEN 'drafts' THEN 1 WHEN 'sent' THEN 2 WHEN 'archive' THEN 3
                   WHEN 'junk' THEN 4 WHEN 'trash' THEN 5 ELSE 6 END, f.path`, [id]);
      return {
        folders: rows.map((f) => ({ id: f.id, path: f.path, name: f.display_name, specialUse: f.special_use, serverCount: f.server_count,
          unread: f.unread, stored: f.stored, lastSyncedAt: f.last_synced_at?.toISOString() ?? null, syncComplete: f.initial_done, selectable: f.selectable })),
      };
    });
  });

  /**
   * Message lists. view=inbox: every connected mailbox's inbox (unified). mailboxId (+ folderId): one mailbox.
   * view=stored_only: platform copies of messages that no longer exist on the server.
   */
  app.get('/v1/messages', active, async (req) => {
    const q = parse(z.object({
      view: z.enum(['inbox', 'folder', 'stored_only', 'flagged']).default('inbox'),
      mailboxId: z.string().uuid().optional(),
      folderId: z.string().uuid().optional(),
      unread: z.enum(['1', '0']).optional(),
      before: z.string().max(80).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }), req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q.view === 'folder') {
      if (!q.folderId) throw new AppError(400, 'validation_failed', 'folderId is required for view=folder.');
      where.push(`EXISTS (SELECT 1 FROM message_locations l WHERE l.message_id = m.id AND l.folder_id = ${p(q.folderId)})`);
    } else if (q.view === 'inbox') {
      where.push(`EXISTS (SELECT 1 FROM message_locations l JOIN folders f ON f.id = l.folder_id WHERE l.message_id = m.id AND f.special_use = 'inbox')`);
    } else if (q.view === 'stored_only') {
      where.push(`m.server_state = 'deleted_on_server'`);
    } else {
      where.push(`m.is_flagged`);
    }
    if (q.mailboxId) where.push(`m.mailbox_id = ${p(q.mailboxId)}`);
    if (q.unread === '1') where.push('NOT m.is_seen');
    if (q.before) {
      const [ts, id] = q.before.split('|');
      if (!ts || !id || Number.isNaN(Date.parse(ts))) throw new AppError(400, 'validation_failed', 'Invalid cursor.');
      where.push(`(m.received_at, m.id) < (${p(ts)}::timestamptz, ${p(id)}::uuid)`);
    }
    const limit = q.limit;
    const { rows } = await withUser(db.api, uidOf(req), (c) => c.query<ListRow>(
      `${LIST_SELECT} WHERE ${where.join(' AND ')} ORDER BY m.received_at DESC, m.id DESC LIMIT ${limit + 1}`, params));
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      messages: page.map(summary),
      nextCursor: rows.length > limit && last ? `${last.received_at.toISOString()}|${last.id}` : null,
    };
  });

  app.get('/v1/messages/:id', active, async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ remoteImages: z.enum(['1', '0']).optional() }), req.query);
    const uid = uidOf(req);
    const load = () => withUser(db.api, uid, async (c) => {
      const base = await loadSummary(c, id);
      if (!base) return null;
      const [detail, body, addrs, atts, locs] = await Promise.all([
        c.query<{ message_id_header: string | null; in_reply_to: string | null; sent_at: Date | null; size_bytes: number | null; body_state: string;
                  auth_results: unknown; mailbox_id: string }>(
          `SELECT message_id_header, in_reply_to, sent_at, size_bytes, body_state, auth_results, mailbox_id FROM messages WHERE id = $1`, [id]),
        c.query<{ text_body: string | null; html_sanitized: string | null; has_remote_content: boolean }>(
          `SELECT text_body, html_sanitized, has_remote_content FROM message_bodies WHERE message_id = $1`, [id]),
        c.query<{ kind: string; address: string; name: string | null }>(`SELECT kind, address, name FROM message_addresses WHERE message_id = $1 ORDER BY kind, position`, [id]),
        c.query<{ id: string; filename: string; mime_type: string; size_bytes: number; is_inline: boolean; risk_level: string; content_id: string | null }>(
          `SELECT id, filename, mime_type, size_bytes, is_inline, risk_level, content_id FROM attachments WHERE message_id = $1 ORDER BY part_id`, [id]),
        c.query<{ folder_id: string; display_name: string; special_use: string | null }>(
          `SELECT f.id AS folder_id, f.display_name, f.special_use FROM message_locations l JOIN folders f ON f.id = l.folder_id WHERE l.message_id = $1`, [id]),
      ]);
      return { base, detail: detail.rows[0]!, body: body.rows[0] ?? null, addrs: addrs.rows, atts: atts.rows, locs: locs.rows };
    });
    let m = await load();
    if (!m) throw new AppError(404, 'not_found', 'Message not found.');

    // Body not stored yet (large message, or evicted by retention): fetch it from the server now.
    let bodyError: string | null = null;
    if (!m.body && m.base.onServer) {
      try {
        await withImap(cfg, db.api, uid, m.detail.mailbox_id, async (client) => {
          const loc = await withUser(db.api, uid, (c) => c.query<{ path: string; uid: string }>(
            `SELECT f.path, l.uid FROM message_locations l JOIN folders f ON f.id = l.folder_id WHERE l.message_id = $1 LIMIT 1`, [id]));
          const l = loc.rows[0];
          if (!l) return;
          const lock = await client.getMailboxLock(l.path, { readOnly: true });
          try {
            const meta = await client.fetchOne(l.uid, { bodyStructure: true, size: true }, { uid: true });
            if (!meta) return;
            const body = await fetchBody(client, Number(l.uid), meta.size ?? null, meta.bodyStructure as StructureNode | undefined);
            if (body) await withUser(db.api, uid, (c) => storeBody(c, uid, id, body));
          } finally {
            lock.release();
          }
        });
        m = (await load())!;
      } catch (err) {
        bodyError = err instanceof AppError ? err.message : 'The message body could not be loaded from the server.';
      }
    }
    const allowRemote = q.remoteImages === '1';
    const html = m.body?.html_sanitized ? (allowRemote ? m.body.html_sanitized : blockRemoteImages(m.body.html_sanitized)) : null;
    const addr = (kind: string) => m!.addrs.filter((a) => a.kind === kind).map((a) => ({ address: a.address, name: a.name }));
    return {
      message: {
        ...m.base,
        messageIdHeader: m.detail.message_id_header,
        sentAt: m.detail.sent_at?.toISOString() ?? null,
        sizeBytes: m.detail.size_bytes,
        to: addr('to'), cc: addr('cc'), bcc: addr('bcc'), replyTo: addr('reply_to'), fromList: addr('from'),
        authResults: m.detail.auth_results,
        folders: m.locs.map((l) => ({ id: l.folder_id, name: l.display_name, specialUse: l.special_use })),
        body: m.body ? { text: m.body.text_body, html, hasRemoteContent: m.body.has_remote_content, remoteContentShown: allowRemote } : null,
        bodyError,
        attachments: m.atts.map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mime_type, sizeBytes: a.size_bytes, isInline: a.is_inline,
          risk: a.risk_level, contentId: a.content_id })),
      },
    };
  });

  app.post('/v1/messages/:id/actions', active, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({
      action: z.enum(['mark_read', 'mark_unread', 'flag', 'unflag', 'archive', 'trash', 'spam', 'not_spam', 'move', 'delete_forever']),
      folderId: z.string().uuid().optional(),
      confirm: z.boolean().optional(),
      clientOpId: z.string().uuid().optional(),
    }), req.body);
    const uid = uidOf(req);
    const clientOpId = body.clientOpId ?? randomUUID();

    const queued = await withUser(db.api, uid, async (c) => {
      const { rows } = await c.query<{ mailbox_id: string; is_seen: boolean; is_flagged: boolean; server_state: string; mailbox_status: string }>(
        `SELECT m.mailbox_id, m.is_seen, m.is_flagged, m.server_state, mb.status AS mailbox_status
           FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE m.id = $1 FOR UPDATE OF m`, [id]);
      const msg = rows[0];
      if (!msg) throw new AppError(404, 'not_found', 'Message not found.');
      if (msg.server_state !== 'present') throw new AppError(409, 'conflict', 'This message no longer exists on the mail server; only the copy stored here remains.');
      if (msg.mailbox_status === 'disconnected') throw new AppError(409, 'conflict', 'This mailbox is disconnected.');
      const dup = await c.query(`SELECT id FROM mailbox_operations WHERE client_op_id = $1`, [clientOpId]);
      if (dup.rows[0]) return { opId: (dup.rows[0] as { id: string }).id, mailboxId: msg.mailbox_id };

      const folder = async (special: string) => {
        const f = await c.query<{ id: string }>(`SELECT id FROM folders WHERE mailbox_id = $1 AND special_use = $2 AND exists_on_server`, [msg.mailbox_id, special]);
        return f.rows[0]?.id ?? null;
      };
      const inFolder = async (special: string) => (await c.query(
        `SELECT 1 FROM message_locations l JOIN folders f ON f.id = l.folder_id WHERE l.message_id = $1 AND f.special_use = $2`, [id, special])).rowCount! > 0;

      let op: 'set_flags' | 'move' | 'delete';
      let payload: OperationPayload;
      const flagOp = (add: string[], remove: string[]) => {
        op = 'set_flags';
        payload = { kind: 'set_flags', add, remove, previous: { is_seen: msg.is_seen, is_flagged: msg.is_flagged } };
      };
      const moveTo = async (special: string, missing: string) => {
        const target = await folder(special);
        if (!target) throw new AppError(409, 'conflict', missing);
        op = 'move';
        payload = { kind: 'move', toFolderId: target };
      };
      switch (body.action) {
        case 'mark_read': flagOp(['\\Seen'], []); break;
        case 'mark_unread': flagOp([], ['\\Seen']); break;
        case 'flag': flagOp(['\\Flagged'], []); break;
        case 'unflag': flagOp([], ['\\Flagged']); break;
        case 'archive': await moveTo('archive', 'This mailbox has no Archive folder. Move the message to a folder instead.'); break;
        case 'spam': await moveTo('junk', 'This mailbox has no Junk/Spam folder.'); break;
        case 'not_spam': await moveTo('inbox', 'Inbox not found.'); break;
        case 'trash':
          if (await inFolder('trash')) throw new AppError(409, 'conflict', 'The message is already in Trash. Use "Delete forever" to remove it permanently.');
          await moveTo('trash', 'This mailbox has no Trash folder. Use "Delete forever" (cannot be undone).');
          break;
        case 'move': {
          if (!body.folderId) throw new AppError(400, 'validation_failed', 'Choose a folder.');
          const f = await c.query(`SELECT 1 FROM folders WHERE id = $1 AND mailbox_id = $2 AND exists_on_server AND selectable`, [body.folderId, msg.mailbox_id]);
          if (!f.rowCount) throw new AppError(404, 'not_found', 'Folder not found in this mailbox.');
          op = 'move'; payload = { kind: 'move', toFolderId: body.folderId };
          break;
        }
        case 'delete_forever':
          if (!body.confirm) throw new AppError(400, 'validation_failed', 'Permanent deletion must be confirmed. It cannot be undone.');
          op = 'delete'; payload = { kind: 'delete' };
          break;
      }
      const { rows: ins } = await c.query<{ id: string }>(
        `INSERT INTO mailbox_operations (user_id, mailbox_id, message_id, client_op_id, op, payload) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [uid, msg.mailbox_id, id, clientOpId, op!, JSON.stringify(payload!)]);
      // Flag changes show immediately (marked "pending" until the server confirms). Moves and deletions
      // only show once the server has done them.
      if (op! === 'set_flags') {
        const p = payload! as Extract<OperationPayload, { kind: 'set_flags' }>;
        const seen = p.add.includes('\\Seen') ? true : p.remove.includes('\\Seen') ? false : null;
        const flagged = p.add.includes('\\Flagged') ? true : p.remove.includes('\\Flagged') ? false : null;
        await c.query(`UPDATE messages SET is_seen = coalesce($2, is_seen), is_flagged = coalesce($3, is_flagged), has_pending_ops = true WHERE id = $1`,
          [id, seen, flagged]);
      } else {
        await c.query(`UPDATE messages SET has_pending_ops = true WHERE id = $1`, [id]);
      }
      return { opId: ins[0]!.id, mailboxId: msg.mailbox_id };
    });

    // Try to apply it on the server right away; if that fails it stays pending for the background sync.
    let appliedNow = false;
    let note: string | null = null;
    try {
      await withImap(cfg, db.api, uid, queued.mailboxId, async (client, m) => {
        await processOperations({ cfg, db: db.api, userId: uid, deadline: Date.now() + 20_000, log: (x) => app.log.warn(x) }, client, m, queued.opId);
      });
      const st = await withUser(db.api, uid, (c) => c.query<{ status: string; last_error: string | null }>(
        `SELECT status, last_error FROM mailbox_operations WHERE id = $1`, [queued.opId]));
      appliedNow = st.rows[0]?.status === 'done';
      if (!appliedNow) note = st.rows[0]?.last_error ? `The server did not accept the change yet (${st.rows[0].last_error}). It will be retried.` : null;
    } catch (err) {
      note = `Saved; it will be applied on the mail server at the next sync. (${(err as Error).message})`;
    }
    const message = await withUser(db.api, uid, (c) => loadSummary(c, id));
    return { message, appliedOnServer: appliedNow, note };
  });

  app.get('/v1/messages/:id/attachments/:attachmentId', active, async (req, reply) => {
    const { id, attachmentId } = parse(z.object({ id: z.string().uuid(), attachmentId: z.string().uuid() }), req.params);
    const uid = uidOf(req);
    const info = await withUser(db.api, uid, async (c) => {
      const { rows } = await c.query<{ part_id: string; filename: string; mime_type: string; mailbox_id: string; path: string; uid: string }>(
        `SELECT a.part_id, a.filename, a.mime_type, m.mailbox_id, f.path, l.uid
           FROM attachments a JOIN messages m ON m.id = a.message_id
           JOIN message_locations l ON l.message_id = m.id JOIN folders f ON f.id = l.folder_id
          WHERE a.id = $1 AND a.message_id = $2 LIMIT 1`, [attachmentId, id]);
      return rows[0] ?? null;
    });
    if (!info) throw new AppError(404, 'not_found', 'Attachment not found, or the message is no longer on the server.');
    const data = await withImap(cfg, db.api, uid, info.mailbox_id, async (client) => {
      const lock = await client.getMailboxLock(info.path, { readOnly: true });
      try {
        const d = await client.download(info.uid, info.part_id, { uid: true });
        if (!('content' in d) || !d.content) throw new AppError(404, 'not_found', 'Attachment not found on the server.');
        const chunks: Buffer[] = [];
        for await (const ch of d.content as AsyncIterable<Buffer>) chunks.push(ch);
        return Buffer.concat(chunks);
      } finally {
        lock.release();
      }
    });
    const safeName = info.filename.replace(/[\r\n"\\]/g, '_');
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${safeName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(info.filename)}`)
      .header('x-declared-content-type', info.mime_type)
      .header('cache-control', 'private, no-store')
      .send(data);
  });
}
