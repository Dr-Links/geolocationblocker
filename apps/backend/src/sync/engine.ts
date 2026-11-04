import type { FetchMessageObject, ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Config } from '../lib/config.js';
import { withUser, type Db, type Tx } from '../lib/db.js';
import { classify, MailError, mailError } from '../mail/errors.js';
import { createImapClient, toMailError } from '../mail/imap.js';
import { getMailbox, loadSecrets, pinsOf, recordFailure, settingsOf, type MailboxRow } from '../mailboxes/repo.js';
import {
  analyseStructure, authResultsOf, decodeFlags, htmlToText, messageIds, parseHeaderBlock, priorityOf, sanitizeEmailHtml,
  snippetOf, stripAngle, type StructureNode,
} from './parse.js';
import {
  applyServerFlags, removeLocations, specialOf, storeBody, storeMessage, upsertFolders, type FolderRow, type IncomingMessage,
} from './store.js';
import { processOperations } from './operations.js';
import { enqueueProblem } from '../push/notify.js';

/** Full message source is downloaded only up to this size; larger messages get their text parts only. */
const FULL_FETCH_LIMIT = 2 * 1024 * 1024;
const TEXT_PART_LIMIT = 1024 * 1024;
/** New messages imported per folder per run (the rest follows in the next runs, newest first). */
const BATCH_PER_FOLDER = 150;
const FOLDER_ORDER = ['inbox', 'sent', 'archive', 'junk', 'drafts', 'trash'];
const EXTRA_HEADERS = ['references', 'x-priority', 'importance', 'priority', 'authentication-results'];

export interface SyncEnv {
  cfg: Config;
  db: Db;
  userId: string;
  deadline: number;
  log: (m: string) => void;
}

export interface SyncResult {
  mailboxId: string;
  ok: boolean;
  folders: number;
  newMessages: number;
  /** New messages in the inbox after the first full sync: these are the ones to notify about. */
  newInbox: Array<{ id: string }>;
  removed: number;
  flagUpdates: number;
  operations: number;
  error?: string;
}

const outOfTime = (env: SyncEnv, reserveMs = 3000) => Date.now() > env.deadline - reserveMs;

function addressList(list: Array<{ name?: string; address?: string }> | undefined, kind: IncomingMessage['addresses'][number]['kind']) {
  return (list ?? []).filter((a) => a.address).slice(0, 100).map((a) => ({ kind, address: a.address!.toLowerCase(), name: a.name?.trim() || null }));
}

async function readStream(s: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const chunk of s as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    n += chunk.length;
    if (n >= limit) break;
  }
  return Buffer.concat(chunks).subarray(0, limit);
}

/** Downloads and prepares the readable body of one message (never marks it as read: the folder is opened read-only or BODY.PEEK is used). */
export async function fetchBody(client: ImapFlow, uid: number, size: number | null, structure: StructureNode | undefined) {
  if ((size ?? 0) <= FULL_FETCH_LIMIT) {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) return null;
    const parsed = await simpleParser(msg.source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
    const html = parsed.html ? sanitizeEmailHtml(parsed.html) : null;
    const text = parsed.text ?? (parsed.html ? htmlToText(parsed.html) : null);
    return { text: text?.slice(0, 2_000_000) ?? null, html: html?.html ?? null, hasRemoteContent: html?.hasRemoteContent ?? false, snippet: snippetOf(text) };
  }
  const { textPart, htmlPart } = analyseStructure(structure);
  let text: string | null = null;
  let html: ReturnType<typeof sanitizeEmailHtml> | null = null;
  if (textPart) {
    const d = await client.download(String(uid), textPart, { uid: true });
    if ('content' in d && d.content) text = (await readStream(d.content, TEXT_PART_LIMIT)).toString('utf8');
  }
  if (htmlPart) {
    const d = await client.download(String(uid), htmlPart, { uid: true });
    if ('content' in d && d.content) html = sanitizeEmailHtml((await readStream(d.content, TEXT_PART_LIMIT)).toString('utf8'));
  }
  if (!text && html) text = htmlToText(html.html);
  if (!text && !html) return null;
  return { text, html: html?.html ?? null, hasRemoteContent: html?.hasRemoteContent ?? false, snippet: snippetOf(text) };
}

export function toIncoming(msg: FetchMessageObject, folderId: string, uidValidity: number): IncomingMessage {
  const env = msg.envelope ?? {};
  const headers = parseHeaderBlock(msg.headers);
  const messageIdHeader = stripAngle(env.messageId);
  const structure = analyseStructure(msg.bodyStructure as StructureNode | undefined);
  // Identity: server-provided stable id when available, else Message-ID + size (so copies merge), else per-folder UID.
  const providerKey = msg.emailId ? `e:${msg.emailId}`
    : messageIdHeader ? `m:${messageIdHeader}:${msg.size ?? 0}`
    : `u:${folderId}:${uidValidity}:${msg.uid}`;
  const addresses = [
    ...addressList(env.from, 'from'), ...addressList(env.to, 'to'), ...addressList(env.cc, 'cc'),
    ...addressList(env.bcc, 'bcc'), ...addressList(env.replyTo, 'reply_to'),
  ];
  const from = addresses.find((a) => a.kind === 'from') ?? null;
  const received = msg.internalDate ? new Date(msg.internalDate) : env.date ? new Date(env.date) : new Date();
  return {
    providerKey,
    messageIdHeader,
    inReplyTo: stripAngle(env.inReplyTo),
    references: messageIds(headers.references),
    subject: env.subject ?? null,
    from: from ? { address: from.address, name: from.name } : null,
    addresses,
    sentAt: env.date ? new Date(env.date) : null,
    receivedAt: Number.isNaN(received.getTime()) ? new Date() : received,
    sizeBytes: msg.size ?? null,
    priority: priorityOf(headers),
    flags: decodeFlags(msg.flags),
    authResults: authResultsOf(headers),
    attachments: structure.attachments,
    body: null,
  };
}

function orderFolders(folders: FolderRow[]): FolderRow[] {
  const rank = (f: FolderRow) => {
    const i = FOLDER_ORDER.indexOf(f.special_use ?? '');
    return i === -1 ? FOLDER_ORDER.length : i;
  };
  return [...folders].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
}

async function syncFolder(env: SyncEnv, client: ImapFlow, mailbox: MailboxRow, folder: FolderRow, result: SyncResult) {
  const lock = await client.getMailboxLock(folder.path, { readOnly: true });
  try {
    const box = client.mailbox;
    if (!box) return;
    const uidValidity = Number(box.uidValidity);
    const wasInitialDone = folder.initial_done;

    await withUser(env.db, env.userId, async (c) => {
      if (folder.uidvalidity !== null && Number(folder.uidvalidity) !== uidValidity) {
        // The server renumbered this folder: forget its UIDs; messages are re-linked by identity below.
        const { rows } = await c.query<{ uid: number }>(`SELECT uid FROM message_locations WHERE folder_id = $1`, [folder.id]);
        await removeLocations(c, folder.id, rows.map((r) => Number(r.uid)));
        await c.query(`UPDATE folders SET highestmodseq = NULL, initial_done = false WHERE id = $1`, [folder.id]);
        folder.highestmodseq = null;
      }
    });

    const serverUids = box.exists ? ((await client.search({ all: true }, { uid: true })) || []) : [];
    const serverSet = new Set(serverUids);
    const stored = await withUser(env.db, env.userId, (c) =>
      c.query<{ uid: string }>(`SELECT uid FROM message_locations WHERE folder_id = $1`, [folder.id]));
    const storedSet = new Set(stored.rows.map((r) => Number(r.uid)));

    // 1. Copies deleted or moved away on the server.
    const gone = [...storedSet].filter((u) => !serverSet.has(u));
    if (gone.length) result.removed += await withUser(env.db, env.userId, (c) => removeLocations(c, folder.id, gone));

    // 2. New copies inside the sync window, newest first, in batches.
    const since = new Date(Date.now() - mailbox.sync_window_days * 86_400_000);
    const inWindow = box.exists ? ((await client.search({ since }, { uid: true })) || []) : [];
    const missing = inWindow.filter((u) => !storedSet.has(u)).sort((a, b) => b - a);
    const batch = missing.slice(0, BATCH_PER_FOLDER);
    for (let i = 0; i < batch.length && !outOfTime(env); i += 25) {
      const chunk = batch.slice(i, i + 25);
      const fetched: FetchMessageObject[] = [];
      for await (const msg of client.fetch(chunk.join(','), {
        uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true, emailId: true, headers: EXTRA_HEADERS,
      }, { uid: true })) fetched.push(msg);
      for (const msg of fetched) {
        if (outOfTime(env)) break;
        const incoming = toIncoming(msg, folder.id, uidValidity);
        try {
          incoming.body = await fetchBody(client, msg.uid, msg.size ?? null, msg.bodyStructure as StructureNode | undefined);
        } catch (err) {
          env.log(`body fetch failed for uid ${msg.uid} in ${folder.path}: ${(err as Error).message}`);
        }
        const r = await withUser(env.db, env.userId, (c) => storeMessage(c, env.userId, mailbox.id, folder.id, msg.uid, incoming));
        if (r.created) {
          result.newMessages++;
          if (folder.special_use === 'inbox' && wasInitialDone && !incoming.flags.is_seen) result.newInbox.push({ id: r.id });
        }
      }
    }
    const caughtUp = missing.length <= batch.length && !outOfTime(env);

    // 3. Flag changes. With CONDSTORE only changed messages are sent; otherwise re-read flags of recent copies.
    if (!outOfTime(env) && storedSet.size) {
      const modseqSupported = box.highestModseq !== undefined && !box.noModseq;
      const known = [...storedSet].filter((u) => serverSet.has(u));
      const range = modseqSupported && folder.highestmodseq ? '1:*' : known.sort((a, b) => b - a).slice(0, 1000).join(',');
      if (range) {
        const opts = modseqSupported && folder.highestmodseq ? { uid: true, changedSince: BigInt(folder.highestmodseq) } : { uid: true };
        const updates: Array<{ uid: number; flags: ReturnType<typeof decodeFlags>; modseq: string | null }> = [];
        for await (const msg of client.fetch(range, { uid: true, flags: true }, opts)) {
          if (storedSet.has(msg.uid)) updates.push({ uid: msg.uid, flags: decodeFlags(msg.flags), modseq: msg.modseq?.toString() ?? null });
        }
        if (updates.length) {
          await withUser(env.db, env.userId, async (c) => {
            for (const u of updates) await applyServerFlags(c, folder.id, u.uid, u.flags, u.modseq);
          });
          result.flagUpdates += updates.length;
        }
      }
    }

    await withUser(env.db, env.userId, (c) => c.query(
      `UPDATE folders SET uidvalidity = $2, uidnext = $3, highestmodseq = $4, server_count = $5, initial_done = initial_done OR $6,
              last_synced_at = now(), next_sync_at = CASE WHEN special_use = 'inbox' THEN now() ELSE now() + interval '5 minutes' END
        WHERE id = $1`,
      [folder.id, uidValidity, box.uidNext, box.highestModseq?.toString() ?? null, box.exists, caughtUp]));
    folder.initial_done = folder.initial_done || caughtUp;
    result.folders++;
  } finally {
    lock.release();
  }
}

/** Opens a connection to the mailbox and runs one synchronisation pass within the deadline. */
export async function syncMailbox(env: SyncEnv, mailboxId: string): Promise<SyncResult> {
  const result: SyncResult = { mailboxId, ok: false, folders: 0, newMessages: 0, newInbox: [], removed: 0, flagUpdates: 0, operations: 0 };
  const loaded = await withUser(env.db, env.userId, async (c) => {
    const m = await getMailbox(c, mailboxId);
    return m && m.status === 'active' ? { m, secrets: await loadSecrets(c, env.cfg, mailboxId) } : null;
  });
  if (!loaded?.secrets) return { ...result, error: 'not_active' };
  const mailbox = loaded.m;

  let client: ImapFlow | null = null;
  try {
    client = await createImapClient(env.cfg, settingsOf(mailbox).imap, loaded.secrets.imapPassword, pinsOf(mailbox).imap);
    client.on('error', (e: Error) => env.log(`imap error (${mailbox.email_address}): ${e.message}`));
    await client.connect();

    result.operations = await processOperations(env, client, mailbox);

    const listed = await client.list();
    const folders = await withUser(env.db, env.userId, (c) => upsertFolders(c, env.userId, mailbox.id, listed.map((f) => ({
      path: f.path,
      delimiter: f.delimiter ?? null,
      name: f.name,
      specialUse: specialOf(f.path, f.specialUse),
      selectable: !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent'),
    }))));
    for (const folder of orderFolders(folders)) {
      if (outOfTime(env)) break;
      if (!folder.selectable || !folder.sync_enabled) continue;
      // When copies vanished from a folder earlier in this run they may have been moved: check every folder now,
      // so a moved message is found in its new folder instead of showing as deleted until the next full check.
      const due = result.removed > 0 || folder.special_use === 'inbox' || !folder.initial_done || !folder.next_sync_at || folder.next_sync_at <= new Date();
      if (!due) continue;
      await syncFolder(env, client, mailbox, folder, result);
    }
    const allDone = folders.filter((f) => f.selectable && f.sync_enabled).every((f) => f.initial_done);
    await withUser(env.db, env.userId, (c) => c.query(
      `UPDATE mailboxes SET last_full_sync_at = now(), initial_sync_done = initial_sync_done OR $2,
              last_incoming_at = CASE WHEN $3 THEN now() ELSE last_incoming_at END,
              consecutive_failures = 0, last_verified_at = now() WHERE id = $1`,
      [mailbox.id, allDone, result.newInbox.length > 0]));
    result.ok = true;
  } catch (err) {
    const e = err instanceof MailError ? err
      : classify(err) === 'UNKNOWN' && client?.usable ? mailError('PROTOCOL_ERROR', 'imap', mailbox.imap_host, mailbox.imap_port)
      : await toMailError(env.cfg, err, 'imap', settingsOf(mailbox).imap);
    result.error = `${e.code}: ${(err as Error).message}`;
    env.log(`sync ${mailbox.email_address} failed: ${result.error}`);
    await withUser(env.db, env.userId, async (c: Tx) => {
      const needsUser = await recordFailure(c, mailbox, e);
      if (needsUser) {
        await enqueueProblem(c, env.userId, 'mailbox_problem', `mailbox_problem:${mailbox.id}:${Date.now() - (Date.now() % 3600_000)}`,
          e.code === 'AUTH_FAILED' ? `${mailbox.email_address} needs its new password` : `${mailbox.email_address} cannot be reached`,
          { type: 'mailbox_problem', mailboxId: mailbox.id }, mailbox.id);
      }
    });
  } finally {
    if (client) await client.logout().catch(() => client!.close());
  }
  return result;
}

export { storeBody };
