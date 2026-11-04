import type { Config } from '../lib/config.js';
import { withUser, type Db } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { putBlob, readBlob } from '../storage/blobs.js';
import { withImap } from './live.js';

/** Largest attachment kept as a platform copy when first downloaded (bigger ones are always fetched live). */
export const CACHE_LIMIT = 10 * 1024 * 1024;

/**
 * Returns an attachment's bytes: from the platform copy when there is one, otherwise from the mail server
 * (and keeps a copy for next time if it is not too large).
 */
export async function attachmentBytes(cfg: Config, db: Db, userId: string, attachmentId: string, messageId: string) {
  const info = await withUser(db, userId, async (c) => {
    const { rows } = await c.query<{ part_id: string; filename: string; mime_type: string; blob_id: string | null; mailbox_id: string; size_bytes: number }>(
      `SELECT a.part_id, a.filename, a.mime_type, a.blob_id, m.mailbox_id, a.size_bytes FROM attachments a JOIN messages m ON m.id = a.message_id
        WHERE a.id = $1 AND a.message_id = $2`, [attachmentId, messageId]);
    return rows[0] ?? null;
  });
  if (!info) throw new AppError(404, 'not_found', 'Attachment not found.');
  if (info.blob_id) {
    const data = await withUser(db, userId, (c) => readBlob(c, cfg, userId, info.blob_id!));
    return { data, filename: info.filename, mimeType: info.mime_type };
  }
  const loc = await withUser(db, userId, (c) => c.query<{ path: string; uid: string }>(
    `SELECT f.path, l.uid FROM message_locations l JOIN folders f ON f.id = l.folder_id WHERE l.message_id = $1 LIMIT 1`, [messageId]));
  const l = loc.rows[0];
  if (!l) throw new AppError(404, 'not_found', 'This message is no longer on the mail server and its attachment was not stored here.');
  const data = await withImap(cfg, db, userId, info.mailbox_id, async (client) => {
    const lock = await client.getMailboxLock(l.path, { readOnly: true });
    try {
      const d = await client.download(l.uid, info.part_id, { uid: true });
      if (!('content' in d) || !d.content) throw new AppError(404, 'not_found', 'Attachment not found on the server.');
      const chunks: Buffer[] = [];
      for await (const ch of d.content as AsyncIterable<Buffer>) chunks.push(ch);
      return Buffer.concat(chunks);
    } finally {
      lock.release();
    }
  });
  if (data.length <= CACHE_LIMIT) {
    await withUser(db, userId, async (c) => {
      const blob = await putBlob(c, cfg, userId, data);
      await c.query(`UPDATE attachments SET blob_id = $2 WHERE id = $1`, [attachmentId, blob.id]);
    });
  }
  return { data, filename: info.filename, mimeType: info.mime_type };
}
