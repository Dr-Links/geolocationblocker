import type { Tx } from '../lib/db.js';

export interface StorageStatus {
  usedBytes: number;
  quotaBytes: number;
  bodyBytes: number;
  fileBytes: number;
  messageCount: number;
  state: 'ok' | 'warning' | 'full';
  bodyRetentionDays: number | null;
}

/** The current user's storage figures (call inside withUser). */
export async function storageStatus(c: Tx): Promise<StorageStatus> {
  const [s, p] = await Promise.all([
    c.query<{ used_bytes: string; quota_bytes: string; body_bytes: string; blob_bytes: string; message_count: string; state: StorageStatus['state'] }>(
      `SELECT * FROM app.my_storage_status()`),
    c.query<{ body_retention_days: number | null }>(`SELECT body_retention_days FROM storage_preferences`),
  ]);
  const r = s.rows[0];
  return {
    usedBytes: Number(r?.used_bytes ?? 0),
    quotaBytes: Number(r?.quota_bytes ?? 0),
    bodyBytes: Number(r?.body_bytes ?? 0),
    fileBytes: Number(r?.blob_bytes ?? 0),
    messageCount: Number(r?.message_count ?? 0),
    state: r?.state ?? 'ok',
    bodyRetentionDays: p.rows[0]?.body_retention_days ?? null,
  };
}

/** Whether new copies (message text, attachment copies, uploads) may be stored for the current user. */
export async function canStore(c: Tx): Promise<boolean> {
  const { rows } = await c.query<{ state: string }>(`SELECT state FROM app.my_storage_status()`);
  return rows[0]?.state !== 'full';
}
