import type { Config } from '../lib/config.js';
import { withUser, type Db } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { putBlob, readBlob } from '../storage/blobs.js';
import { canStore } from '../storage/quota.js';
import { enforceScan, scanBytes } from '../security/clamav.js';
import { refreshSecurity } from '../security/flags.js';
import { withImap } from './live.js';

/** Largest attachment kept as a platform copy when first downloaded (bigger ones are always fetched live). */
export const CACHE_LIMIT = 10 * 1024 * 1024;

/**
 * Returns an attachment's bytes: from the platform copy when there is one, otherwise from the mail server
 * (and keeps a copy for next time if it is not too large).
 */
export async function attachmentBytes(cfg: Config, db: Db, userId: string, attachmentId: string, messageId: string) {
  const info = await withUser(db, userId, async (c) => {
    const { rows } = await c.query<{ part_id: string; filename: string; mime_type: string; blob_id: string | null; mailbox_id: string; size_bytes: number;
                                      scan_status: string | null; scan_detail: string | null }>(
      `SELECT a.part_id, a.filename, a.mime_type, a.blob_id, m.mailbox_id, a.size_bytes, a.scan_status, a.scan_detail
         FROM attachments a JOIN messages m ON m.id = a.message_id
        WHERE a.id = $1 AND a.message_id = $2`, [attachmentId, messageId]);
    return rows[0] ?? null;
  });
  if (!info) throw new AppError(404, 'not_found', 'Attachment not found.');
  if (info.scan_status === 'infected') enforceScan(cfg, { status: 'infected', detail: info.scan_detail ?? 'malware' }, 'this attachment');
  // Scanned once (when a scanner is configured); the result is kept with the attachment.
  const checked = async (data: Buffer) => {
    if (!cfg.clamav || info.scan_status === 'clean') return data;
    const r = await scanBytes(cfg, data);
    await withUser(db, userId, async (c) => {
      await c.query(`UPDATE attachments SET scan_status = $2, scan_detail = $3, scanned_at = now(),
                            risk_level = CASE WHEN $2 = 'infected' THEN 'dangerous' ELSE risk_level END WHERE id = $1`,
        [attachmentId, r.status === 'skipped' ? null : r.status, r.detail ?? null]);
      if (r.status === 'infected') await refreshSecurity(c, messageId, null);
    });
    enforceScan(cfg, r, 'this attachment');
    return data;
  };
  if (info.blob_id) {
    const data = await checked(await withUser(db, userId, (c) => readBlob(c, cfg, userId, info.blob_id!)));
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
  await checked(data);
  if (data.length <= CACHE_LIMIT) {
    await withUser(db, userId, async (c) => {
      if (!(await canStore(c))) return; // storage full: serve it, keep no copy
      const blob = await putBlob(c, cfg, userId, data);
      await c.query(`UPDATE attachments SET blob_id = $2 WHERE id = $1`, [attachmentId, blob.id]);
    });
  }
  return { data, filename: info.filename, mimeType: info.mime_type };
}
