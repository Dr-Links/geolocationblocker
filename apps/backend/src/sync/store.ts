import type { Tx } from '../lib/db.js';
import { normalizeSubject, type AttachmentMeta } from './parse.js';

export interface FolderRow {
  id: string;
  mailbox_id: string;
  path: string;
  display_name: string;
  special_use: string | null;
  uidvalidity: number | null;
  uidnext: number | null;
  highestmodseq: string | null;
  server_count: number;
  selectable: boolean;
  sync_enabled: boolean;
  exists_on_server: boolean;
  initial_done: boolean;
  next_sync_at: Date | null;
}

export interface ListedFolder {
  path: string;
  delimiter: string | null;
  name: string;
  specialUse: string | null;
  selectable: boolean;
}

const SPECIAL: Record<string, string> = {
  '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Trash': 'trash', '\\Junk': 'junk',
  '\\Archive': 'archive', '\\All': 'all', '\\Flagged': 'flagged',
};
export const specialOf = (path: string, specialUse?: string | null) =>
  path.toUpperCase() === 'INBOX' ? 'inbox' : (specialUse && SPECIAL[specialUse]) || null;

/** Inserts new folders, updates existing ones, and marks folders deleted on the server. */
export async function upsertFolders(c: Tx, userId: string, mailboxId: string, listed: ListedFolder[]): Promise<FolderRow[]> {
  const usedSpecial = new Set<string>();
  for (const f of listed) {
    let special = f.specialUse;
    if (special && usedSpecial.has(special)) special = null; // at most one folder per special use
    if (special) usedSpecial.add(special);
    await c.query(
      `INSERT INTO folders (user_id, mailbox_id, path, delimiter, display_name, special_use, selectable)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (mailbox_id, path) DO UPDATE SET delimiter = EXCLUDED.delimiter, display_name = EXCLUDED.display_name,
              special_use = EXCLUDED.special_use, selectable = EXCLUDED.selectable, exists_on_server = true`,
      [userId, mailboxId, f.path, f.delimiter, f.name, special, f.selectable]);
  }
  await c.query(`UPDATE folders SET exists_on_server = false WHERE mailbox_id = $1 AND NOT (path = ANY($2))`,
    [mailboxId, listed.map((f) => f.path)]);
  const { rows } = await c.query<FolderRow>(`SELECT * FROM folders WHERE mailbox_id = $1 AND exists_on_server`, [mailboxId]);
  return rows;
}

export interface IncomingMessage {
  providerKey: string;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string | null;
  from: { address: string; name: string | null } | null;
  addresses: Array<{ kind: 'from' | 'to' | 'cc' | 'bcc' | 'reply_to'; address: string; name: string | null }>;
  sentAt: Date | null;
  receivedAt: Date;
  sizeBytes: number | null;
  priority: 'high' | 'normal' | 'low';
  flags: { is_seen: boolean; is_flagged: boolean; is_answered: boolean; is_draft: boolean; is_forwarded: boolean; keywords: string[] };
  authResults: Record<string, string | undefined> | null;
  attachments: AttachmentMeta[];
  body: { text: string | null; html: string | null; hasRemoteContent: boolean; snippet: string | null } | null;
  /** Set when the text was not fetched because the user's storage is full. */
  skippedForQuota?: boolean;
}

/**
 * Finds the conversation for a message:
 *  1. by its In-Reply-To/References, and by earlier-arrived replies that point to it — if these link
 *     several existing conversations, they are merged into one;
 *  2. only for messages that are clearly replies whose original we do not have: the same normalised
 *     subject, a shared participant, and within 14 days. A similar subject alone never merges.
 */
async function threadFor(c: Tx, userId: string, m: IncomingMessage): Promise<string> {
  const parents = [m.inReplyTo, ...m.references].filter((x): x is string => !!x);
  const ids = new Set<string>();
  if (parents.length) {
    const { rows } = await c.query<{ thread_id: string }>(
      `SELECT DISTINCT thread_id FROM messages WHERE message_id_header = ANY($1)`, [parents]);
    rows.forEach((r) => ids.add(r.thread_id));
  }
  if (m.messageIdHeader) {
    const { rows } = await c.query<{ thread_id: string }>(
      `SELECT DISTINCT thread_id FROM messages WHERE in_reply_to = $1 OR $1 = ANY(references_ids)`, [m.messageIdHeader]);
    rows.forEach((r) => ids.add(r.thread_id));
  }
  if (ids.size) {
    const [target, ...others] = [...ids];
    if (others.length) {
      await c.query(`UPDATE messages SET thread_id = $1 WHERE thread_id = ANY($2)`, [target, others]);
      await c.query(`UPDATE threads SET last_message_at = greatest(last_message_at, (SELECT max(last_message_at) FROM threads WHERE id = ANY($2))) WHERE id = $1`, [target, others]);
    }
    return target!;
  }
  const norm = normalizeSubject(m.subject).slice(0, 300);
  const looksLikeReply = parents.length > 0 || /^\s*(re|fwd?|fw|aw|sv|wg)\s*:/i.test(m.subject ?? '');
  // The user's own addresses are in every message of theirs, so they never count as a shared participant.
  const own = new Set((await c.query<{ email_address: string }>(`SELECT email_address FROM mailboxes`)).rows.map((r) => r.email_address));
  const participants = [...new Set(m.addresses.map((a) => a.address))].filter((a) => !own.has(a));
  if (looksLikeReply && norm && participants.length) {
    const { rows } = await c.query<{ id: string }>(
      `SELECT t.id FROM threads t
        WHERE t.subject_normalized = $1 AND t.last_message_at > $2::timestamptz - interval '14 days'
          AND EXISTS (SELECT 1 FROM messages mm JOIN message_addresses a ON a.message_id = mm.id
                       WHERE mm.thread_id = t.id AND a.address = ANY($3))
        ORDER BY t.last_message_at DESC LIMIT 1`, [norm, m.receivedAt, participants]);
    if (rows[0]) return rows[0].id;
  }
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO threads (user_id, subject_normalized, last_message_at) VALUES ($1, $2, $3) RETURNING id`,
    [userId, norm, m.receivedAt]);
  return rows[0]!.id;
}

/**
 * Stores a message found in a folder. If the same message is already known (another copy, or a move
 * between folders), only a new location is added: the platform never shows duplicates.
 * Returns whether the message is new to the platform.
 */
export async function storeMessage(c: Tx, userId: string, mailboxId: string, folderId: string, uid: number, m: IncomingMessage): Promise<{ id: string; created: boolean }> {
  const existing = await c.query<{ id: string }>(`SELECT id FROM messages WHERE mailbox_id = $1 AND provider_key = $2`, [mailboxId, m.providerKey]);
  let id = existing.rows[0]?.id;
  let created = false;
  if (!id) {
    // Mailboxes of one user sync in parallel; serialise conversation assignment per user so that a reply
    // stored in one mailbox and its original stored in another at the same moment still end up together.
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`thread:${userId}`]);
    const threadId = await threadFor(c, userId, m);
    const toSummary = m.addresses.filter((a) => a.kind === 'to').slice(0, 3).map((a) => a.name || a.address).join(', ') || null;
    const text = m.body?.text ?? '';
    const r = await c.query<{ id: string }>(
      `INSERT INTO messages (user_id, mailbox_id, thread_id, provider_key, message_id_header, in_reply_to, references_ids, subject,
              from_address, from_name, to_summary, sent_at, received_at, size_bytes, snippet, priority, is_seen, is_flagged,
              is_answered, is_draft, is_forwarded, keywords, has_attachments, body_state, auth_results, search_vector)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
               setweight(to_tsvector('simple', coalesce($8, '')), 'A') ||
               setweight(to_tsvector('simple', coalesce($9, '') || ' ' || coalesce($10, '') || ' ' || coalesce($26, '')), 'B') ||
               setweight(to_tsvector('simple', left(coalesce($27, ''), 100000)), 'C') ||
               setweight(to_tsvector('simple', coalesce($28, '')), 'D'))
       ON CONFLICT (mailbox_id, provider_key) DO NOTHING RETURNING id`,
      [userId, mailboxId, threadId, m.providerKey, m.messageIdHeader, m.inReplyTo, m.references, m.subject?.slice(0, 1000) ?? null,
       m.from?.address ?? null, m.from?.name ?? null, toSummary, m.sentAt, m.receivedAt, m.sizeBytes, m.body?.snippet ?? null,
       m.priority, m.flags.is_seen, m.flags.is_flagged, m.flags.is_answered, m.flags.is_draft, m.flags.is_forwarded,
       m.flags.keywords, m.attachments.some((a) => !a.isInline), m.body ? 'stored' : m.skippedForQuota ? 'skipped_quota' : 'headers_only', m.authResults,
       m.addresses.map((a) => `${a.name ?? ''} ${a.address}`).join(' '), text, m.attachments.map((a) => a.filename).join(' ')]);
    if (r.rows[0]) {
      id = r.rows[0].id;
      created = true;
      await c.query(`UPDATE threads SET last_message_at = greatest(last_message_at, $2) WHERE id = $1`, [threadId, m.receivedAt]);
      for (const [i, a] of m.addresses.entries()) {
        await c.query(`INSERT INTO message_addresses (message_id, user_id, kind, position, address, name) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [id, userId, a.kind, i, a.address.slice(0, 254), a.name?.slice(0, 200) ?? null]);
      }
      for (const a of m.attachments) {
        await c.query(`INSERT INTO attachments (user_id, message_id, part_id, filename, mime_type, size_bytes, content_id, is_inline, risk_level)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (message_id, part_id) DO NOTHING`,
          [userId, id, a.partId, a.filename, a.mimeType, a.sizeBytes, a.contentId, a.isInline, a.risk]);
      }
      if (m.body) await storeBody(c, userId, id, m.body, false);
    } else {
      id = (await c.query<{ id: string }>(`SELECT id FROM messages WHERE mailbox_id = $1 AND provider_key = $2`, [mailboxId, m.providerKey])).rows[0]!.id;
    }
  } else {
    await c.query(`UPDATE messages SET server_state = 'present' WHERE id = $1 AND server_state <> 'present'`, [id]);
  }
  await c.query(
    `INSERT INTO message_locations (folder_id, uid, user_id, message_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (folder_id, uid) DO UPDATE SET message_id = EXCLUDED.message_id`, [folderId, uid, userId, id]);
  return { id, created };
}

export async function storeBody(c: Tx, userId: string, messageId: string, body: NonNullable<IncomingMessage['body']>, addToSearch = true) {
  const bytes = Buffer.byteLength(body.text ?? '') + Buffer.byteLength(body.html ?? '');
  await c.query(
    `INSERT INTO message_bodies (message_id, user_id, text_body, html_sanitized, has_remote_content, stored_bytes)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (message_id) DO UPDATE SET text_body = EXCLUDED.text_body, html_sanitized = EXCLUDED.html_sanitized,
            has_remote_content = EXCLUDED.has_remote_content, stored_bytes = EXCLUDED.stored_bytes, stored_at = now()`,
    [messageId, userId, body.text, body.html, body.hasRemoteContent, bytes]);
  await c.query(
    `UPDATE messages SET body_state = 'stored', snippet = coalesce(snippet, $2),
            search_vector = CASE WHEN $3 THEN coalesce(search_vector, ''::tsvector) || setweight(to_tsvector('simple', left(coalesce($4, ''), 100000)), 'C')
                                 ELSE search_vector END
      WHERE id = $1`, [messageId, body.snippet, addToSearch, body.text]);
}

/**
 * Removes folder copies that no longer exist on the server. A message whose last copy disappeared keeps
 * its platform copy, marked "deleted on server", so the app never claims it is still there.
 */
export async function removeLocations(c: Tx, folderId: string, uids: number[]): Promise<number> {
  if (!uids.length) return 0;
  const { rows } = await c.query<{ message_id: string }>(
    `DELETE FROM message_locations WHERE folder_id = $1 AND uid = ANY($2) RETURNING message_id`, [folderId, uids]);
  const ids = [...new Set(rows.map((r) => r.message_id))];
  if (ids.length) {
    await c.query(
      `UPDATE messages m SET server_state = 'deleted_on_server'
        WHERE m.id = ANY($1) AND NOT EXISTS (SELECT 1 FROM message_locations l WHERE l.message_id = m.id)`, [ids]);
  }
  return rows.length;
}

/** Applies flag changes from the server, except for messages with a user action still on its way to the server. */
export async function applyServerFlags(c: Tx, folderId: string, uid: number, flags: IncomingMessage['flags'], modseq: string | null) {
  await c.query(
    `UPDATE messages m SET is_seen = $3, is_flagged = $4, is_answered = $5, is_draft = $6, is_forwarded = $7, keywords = $8
       FROM message_locations l
      WHERE l.folder_id = $1 AND l.uid = $2 AND m.id = l.message_id AND NOT m.has_pending_ops
        AND (m.is_seen, m.is_flagged, m.is_answered, m.is_draft, m.is_forwarded, m.keywords) IS DISTINCT FROM ($3, $4, $5, $6, $7, $8::text[])`,
    [folderId, uid, flags.is_seen, flags.is_flagged, flags.is_answered, flags.is_draft, flags.is_forwarded, flags.keywords]);
  if (modseq) await c.query(`UPDATE message_locations SET modseq = $3 WHERE folder_id = $1 AND uid = $2`, [folderId, uid, modseq]);
}
