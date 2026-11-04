import type { Config } from '../lib/config.js';
import { withUser, type Db } from '../lib/db.js';
import { enqueueProblem } from '../push/notify.js';
import { blobStore, type BlobStore } from './blobs.js';

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;

export interface StorageHousekeeping { users: number; evictedBodies: number; evictedAttachments: number; blobsDeleted: number; objectsDeleted: number; warned: number }

/**
 * Applies retention and quota pressure, warns users who crossed 80 % or filled their storage,
 * deletes files nothing refers to any more, and removes their stored objects.
 * Safe to run from several processes at once.
 */
export async function storageHousekeeping(cfg: Config, db: Db, log: (m: string) => void = console.log, store: BlobStore = blobStore(cfg)): Promise<StorageHousekeeping> {
  const out: StorageHousekeeping = { users: 0, evictedBodies: 0, evictedAttachments: 0, blobsDeleted: 0, objectsDeleted: 0, warned: 0 };
  const { rows } = await db.query<{ s_user_id: string; s_evicted_bodies: number; s_evicted_attachments: number; s_level: number; s_notify: boolean; s_used: string; s_quota: string }>(
    `SELECT * FROM app.apply_storage_policy()`);
  for (const r of rows) {
    out.users++;
    out.evictedBodies += r.s_evicted_bodies;
    out.evictedAttachments += r.s_evicted_attachments;
    if (!r.s_notify) continue;
    out.warned++;
    const used = Number(r.s_used);
    const quota = Number(r.s_quota);
    const title = r.s_level >= 2
      ? `Your storage is full (${gb(quota)}). New message text is no longer saved here.`
      : `You have used ${Math.min(99, Math.floor((used / quota) * 100))} % of your ${gb(quota)} storage.`;
    await withUser(db, r.s_user_id, (c) => enqueueProblem(c, r.s_user_id, 'account', `storage:${r.s_level}:${new Date().toISOString().slice(0, 10)}`,
      title, { type: 'storage', level: r.s_level }));
  }

  const gc = await db.query<{ n: number }>(`SELECT app.gc_blobs() AS n`);
  out.blobsDeleted = gc.rows[0]?.n ?? 0;

  const keys = await db.query<{ t_key: string }>(`SELECT * FROM app.claim_blob_tombstones()`);
  const done: string[] = [];
  for (const k of keys.rows) {
    try {
      await store.delete(k.t_key);
      done.push(k.t_key);
    } catch (err) {
      log(`could not delete stored object ${k.t_key}: ${(err as Error).message}`); // retried later with backoff
    }
  }
  if (done.length) await db.query(`SELECT app.finish_blob_tombstones($1)`, [done]);
  out.objectsDeleted = done.length;
  if (out.evictedBodies || out.evictedAttachments || out.blobsDeleted) {
    log(`storage: evicted ${out.evictedBodies} texts and ${out.evictedAttachments} attachment copies, deleted ${out.blobsDeleted} files`);
  }
  return out;
}
