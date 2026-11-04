import type { ImapFlow } from 'imapflow';
import { withUser, type Tx } from '../lib/db.js';
import type { MailboxRow } from '../mailboxes/repo.js';
import type { SyncEnv } from './engine.js';

export const MAX_OPERATION_ATTEMPTS = 5;

export type OperationPayload =
  | { kind: 'set_flags'; add: string[]; remove: string[]; previous: Record<string, boolean> }
  | { kind: 'move'; toFolderId: string }
  | { kind: 'delete' };

interface OpRow {
  id: string;
  message_id: string | null;
  op: 'set_flags' | 'move' | 'delete';
  payload: OperationPayload;
  attempts: number;
}

interface Location {
  folder_id: string;
  uid: string;
  path: string;
  special_use: string | null;
}

async function locations(c: Tx, messageId: string): Promise<Location[]> {
  const { rows } = await c.query<Location>(
    `SELECT l.folder_id, l.uid, f.path, f.special_use FROM message_locations l JOIN folders f ON f.id = l.folder_id
      WHERE l.message_id = $1 ORDER BY f.special_use = 'inbox' DESC`, [messageId]);
  return rows;
}

async function refreshPending(c: Tx, messageId: string) {
  await c.query(
    `UPDATE messages SET has_pending_ops = EXISTS (SELECT 1 FROM mailbox_operations WHERE message_id = $1 AND status = 'pending')
      WHERE id = $1`, [messageId]);
}

/** Carries out one user action on the IMAP server. Throws when the server refuses. */
async function apply(client: ImapFlow, c: Tx, op: OpRow) {
  const messageId = op.message_id!;
  const locs = await locations(c, messageId);
  if (!locs.length) return; // nothing left on the server to change
  if (op.payload.kind === 'set_flags') {
    const { add, remove } = op.payload;
    for (const l of locs) {
      const lock = await client.getMailboxLock(l.path);
      try {
        if (add.length) await client.messageFlagsAdd(l.uid, add, { uid: true });
        if (remove.length) await client.messageFlagsRemove(l.uid, remove, { uid: true });
      } finally {
        lock.release();
      }
    }
    return;
  }
  if (op.payload.kind === 'move') {
    const { rows } = await c.query<{ id: string; path: string }>(`SELECT id, path FROM folders WHERE id = $1`, [op.payload.toFolderId]);
    const target = rows[0];
    if (!target) throw new Error('Target folder no longer exists.');
    const source = locs.find((l) => l.folder_id !== target.id);
    if (!source) return; // already there
    const lock = await client.getMailboxLock(source.path);
    try {
      const res = await client.messageMove(source.uid, target.path, { uid: true });
      if (!res) throw new Error('The server refused to move the message.');
      await c.query(`DELETE FROM message_locations WHERE folder_id = $1 AND uid = $2`, [source.folder_id, source.uid]);
      const newUid = res.uidMap?.get(Number(source.uid));
      if (newUid) {
        await c.query(`INSERT INTO message_locations (folder_id, uid, user_id, message_id) SELECT $1, $2, user_id, id FROM messages WHERE id = $3
                       ON CONFLICT (folder_id, uid) DO NOTHING`, [target.id, newUid, messageId]);
      }
      // Without UIDPLUS the new copy is picked up (and merged) by the next sync of the target folder.
    } finally {
      lock.release();
    }
    return;
  }
  // Permanent deletion of every copy (only requested for messages in Trash/Junk or by explicit confirmation).
  for (const l of locs) {
    const lock = await client.getMailboxLock(l.path);
    try {
      const ok = await client.messageDelete(l.uid, { uid: true });
      if (!ok) throw new Error('The server refused to delete the message.');
    } finally {
      lock.release();
    }
  }
  // Detach the operation record first, or deleting the message would cascade-delete it before it is marked done.
  await c.query(`UPDATE mailbox_operations SET message_id = NULL WHERE id = $1`, [op.id]);
  await c.query(`DELETE FROM messages WHERE id = $1`, [messageId]);
  op.message_id = null;
}

/**
 * Applies pending user actions for one mailbox, oldest first. Each operation row is locked while it is
 * applied, so the background sync and an immediate attempt from the API never apply it twice.
 * After MAX_OPERATION_ATTEMPTS failures the action is marked failed and a flag change is reverted, so the
 * app never shows a state the server did not accept.
 */
export async function processOperations(env: SyncEnv, client: ImapFlow, mailbox: MailboxRow, onlyId?: string): Promise<number> {
  let done = 0;
  for (;;) {
    const handled = await withUser(env.db, env.userId, async (c) => {
      const { rows } = await c.query<OpRow>(
        `SELECT id, message_id, op, payload, attempts FROM mailbox_operations
          WHERE mailbox_id = $1 AND status = 'pending' AND ($2::uuid IS NULL OR id = $2)
          ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`, [mailbox.id, onlyId ?? null]);
      const op = rows[0];
      if (!op) return false;
      try {
        await apply(client, c, op);
        await c.query(`UPDATE mailbox_operations SET status = 'done', completed_at = now(), attempts = attempts + 1 WHERE id = $1`, [op.id]);
        done++;
      } catch (err) {
        const attempts = op.attempts + 1;
        const failed = attempts >= MAX_OPERATION_ATTEMPTS;
        await c.query(`UPDATE mailbox_operations SET attempts = $2, last_error = $3, status = $4, completed_at = CASE WHEN $5 THEN now() END WHERE id = $1`,
          [op.id, attempts, (err as Error).message.slice(0, 500), failed ? 'failed' : 'pending', failed]);
        if (failed && op.payload.kind === 'set_flags' && op.message_id) {
          const p = op.payload.previous;
          await c.query(`UPDATE messages SET is_seen = coalesce($2, is_seen), is_flagged = coalesce($3, is_flagged) WHERE id = $1`,
            [op.message_id, p.is_seen ?? null, p.is_flagged ?? null]);
        }
        if (failed) {
          await c.query(`INSERT INTO mailbox_events (user_id, mailbox_id, category, severity, code, detail)
                         VALUES (app.current_user_id(), $1, 'sync', 'warning', 'ACTION_FAILED', $2)`,
            [mailbox.id, `A ${op.op.replace('_', ' ')} action could not be applied on the server: ${(err as Error).message}`.slice(0, 500)]);
        }
        if (!failed) return 'retry_later';
      }
      if (op.message_id) await refreshPending(c, op.message_id).catch(() => undefined);
      return true;
    });
    if (handled !== true) break;
    if (onlyId) break;
  }
  return done;
}
