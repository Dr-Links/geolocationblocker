import { randomUUID } from 'node:crypto';
import type { Tx } from '../lib/db.js';

/**
 * A new Inbox message from a blocked sender (the user's own list or the platform list) is marked and
 * moved to the mailbox's Junk folder on the server. It is never deleted, and no notification is sent.
 * Returns where the block came from, or null.
 */
export async function applyBlocklist(c: Tx, userId: string, mailboxId: string, messageId: string, fromAddress: string | null): Promise<'user' | 'platform' | null> {
  if (!fromAddress) return null;
  const { rows } = await c.query<{ src: 'user' | 'platform' | null }>(`SELECT app.sender_blocked($1) AS src`, [fromAddress]);
  const src = rows[0]?.src ?? null;
  if (!src) return null;
  await c.query(
    `UPDATE messages SET security_flags = jsonb_build_object('level', 'danger', 'reasons',
            coalesce(security_flags -> 'reasons', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('code', 'blocked_sender', 'detail', $2::text)))
      WHERE id = $1 AND NOT coalesce(security_flags -> 'reasons', '[]'::jsonb) @> '[{"code":"blocked_sender"}]'`,
    [messageId, src === 'user' ? 'your block list' : 'platform block list']);
  const junk = await c.query<{ id: string }>(`SELECT id FROM folders WHERE mailbox_id = $1 AND special_use = 'junk' AND exists_on_server`, [mailboxId]);
  if (junk.rows[0]) {
    await c.query(`INSERT INTO mailbox_operations (user_id, mailbox_id, message_id, client_op_id, op, payload) VALUES ($1,$2,$3,$4,'move',$5)`,
      [userId, mailboxId, messageId, randomUUID(), JSON.stringify({ kind: 'move', toFolderId: junk.rows[0].id })]);
    await c.query(`UPDATE messages SET has_pending_ops = true WHERE id = $1`, [messageId]);
  }
  return src;
}
