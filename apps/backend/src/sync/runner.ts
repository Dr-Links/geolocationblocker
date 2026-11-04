import type { Config } from '../lib/config.js';
import { withUser, type Db } from '../lib/db.js';
import { syncMailbox, type SyncResult } from './engine.js';
import { enqueueNewMail } from '../push/notify.js';

export interface PassOptions {
  /** Total time for this pass (cron mode: a little under the cron interval). */
  budgetMs: number;
  /** Mailboxes synced at the same time. */
  concurrency?: number;
  /** Minimum time between two syncs of the same mailbox. */
  intervalSeconds?: number;
  log?: (m: string) => void;
  onResult?: (userId: string, r: SyncResult) => Promise<void>;
}

/**
 * One synchronisation pass: repeatedly claims due mailboxes and syncs them until the time budget is used.
 * Mailboxes are leased in the database, so overlapping runs (two cron starts, cron + daemon) never sync
 * the same mailbox at the same time.
 */
export async function runSyncPass(cfg: Config, db: Db, opts: PassOptions): Promise<SyncResult[]> {
  const log = opts.log ?? console.log;
  const deadline = Date.now() + opts.budgetMs;
  const concurrency = opts.concurrency ?? 3;
  const interval = opts.intervalSeconds ?? 60;
  const results: SyncResult[] = [];
  while (Date.now() < deadline - 5000) {
    const leaseSeconds = Math.ceil((deadline - Date.now()) / 1000) + 30;
    const { rows } = await db.query<{ sync_mailbox_id: string; sync_user_id: string }>(
      `SELECT * FROM app.claim_sync_mailboxes($1, $2)`, [concurrency, leaseSeconds]);
    if (!rows.length) break;
    await Promise.all(rows.map(async (r) => {
      let result: SyncResult;
      try {
        result = await syncMailbox({ cfg, db, userId: r.sync_user_id, deadline, log }, r.sync_mailbox_id);
      } catch (err) {
        result = { mailboxId: r.sync_mailbox_id, ok: false, folders: 0, newMessages: 0, newInbox: [], removed: 0, flagUpdates: 0, operations: 0, error: (err as Error).message };
        log(`sync of ${r.sync_mailbox_id} crashed: ${(err as Error).message}`);
      }
      // A mailbox that is still catching up on its initial sync is due again right away.
      await withUser(db, r.sync_user_id, (c) => c.query(
        `UPDATE mailboxes SET sync_lease_until = NULL,
                next_sync_at = CASE WHEN initial_sync_done THEN now() + make_interval(secs => $2) ELSE now() END
          WHERE id = $1`, [r.sync_mailbox_id, interval]));
      if (result.newInbox.length) {
        await withUser(db, r.sync_user_id, async (c) => {
          const { rows: mb } = await c.query<{ email_address: string }>(`SELECT email_address FROM mailboxes WHERE id = $1`, [r.sync_mailbox_id]);
          if (mb[0]) await enqueueNewMail(c, r.sync_user_id, r.sync_mailbox_id, mb[0].email_address, result.newInbox.map((m) => m.id));
        }).catch((e: Error) => log(`could not queue notifications: ${e.message}`));
      }
      results.push(result);
      if (opts.onResult) await opts.onResult(r.sync_user_id, result).catch((e: Error) => log(`after-sync hook failed: ${e.message}`));
    }));
  }
  return results;
}
