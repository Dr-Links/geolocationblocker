import type { Config } from './lib/config.js';
import { withUser, type Db } from './lib/db.js';
import { ConnectFailure, verifyMailbox } from './mail/connect.js';
import { defaultDiscoveryDeps } from './mail/discovery.js';
import { MailError } from './mail/errors.js';
import { getMailbox, loadSecrets, pinsOf, recordFailure, recordSuccess, settingsOf } from './mailboxes/repo.js';
import { emails } from './lib/emails.js';
import { sendSafely, type Mailer } from './lib/mailer.js';
import { enqueueProblem } from './push/notify.js';
import { storageHousekeeping, type StorageHousekeeping } from './storage/housekeeping.js';

export interface TickResult {
  expired: number;
  warned: number;
  mailboxRetries: { attempted: number; recovered: number };
  pruned: Record<string, number>;
  storage: StorageHousekeeping | null;
  reminders: number;
}

/** Re-tests mailboxes whose last connection failed temporarily (bounded by backoff). */
export async function retryMailboxes(db: Db, cfg: Config, mailer: Mailer, log: (m: string) => void, limit = 10) {
  const { rows } = await db.query<{ retry_mailbox_id: string; retry_user_id: string }>(
    `SELECT * FROM app.claim_mailbox_retries($1)`, [limit]);
  let recovered = 0;
  for (const r of rows) {
    const loaded = await withUser(db, r.retry_user_id, async (c) => {
      const m = await getMailbox(c, r.retry_mailbox_id);
      return m && m.status === 'error' ? { m, secrets: await loadSecrets(c, cfg, m.id) } : null;
    });
    if (!loaded?.secrets) continue;
    try {
      await verifyMailbox(cfg, loaded.m.email_address, loaded.secrets,
        { manual: settingsOf(loaded.m), pins: pinsOf(loaded.m), deps: defaultDiscoveryDeps(cfg) });
      await withUser(db, r.retry_user_id, (c) => recordSuccess(c, loaded.m));
      recovered++;
    } catch (err) {
      const e = err instanceof ConnectFailure ? err.error : err;
      if (!(e instanceof MailError)) { log(`mailbox retry ${loaded.m.id} failed unexpectedly: ${(err as Error).message}`); continue; }
      const notify = await withUser(db, r.retry_user_id, async (c) => {
        const needs = await recordFailure(c, loaded.m, e);
        if (!needs) return null;
        const u = await c.query<{ email_display: string }>(`SELECT email_display FROM users WHERE id = app.current_user_id()`);
        await c.query(`UPDATE mailbox_events SET user_notified_at = now() WHERE mailbox_id = $1 AND resolved_at IS NULL AND severity = 'action_required'`, [loaded.m.id]);
        return u.rows[0]?.email_display ?? null;
      });
      if (notify) await sendSafely(mailer, emails.mailboxNeedsAttention(notify, loaded.m.email_address, e.message, e.code === 'AUTH_FAILED'), log);
    }
  }
  return { attempted: rows.length, recovered };
}

/** Follow-up reminders that are due become push notifications (mailbox address only, never subject or sender). */
export async function fireReminders(db: Db): Promise<number> {
  const { rows } = await db.query<{ r_id: string; r_user_id: string; r_message_id: string; r_mailbox_id: string; r_mailbox_email: string }>(
    `SELECT * FROM app.claim_reminders()`);
  for (const r of rows) {
    await withUser(db, r.r_user_id, (c) => enqueueProblem(c, r.r_user_id, 'reminder', `reminder:${r.r_id}:${Date.now()}`,
      `Reminder: follow up on a message in ${r.r_mailbox_email}`, { type: 'reminder', messageId: r.r_message_id, mailboxId: r.r_mailbox_id }, r.r_mailbox_id));
  }
  return rows.length;
}

/**
 * One scheduler pass. On cPanel this runs from cron every minute; on a server it can run in a loop.
 * Safe to run concurrently: the SQL functions lock rows with SKIP LOCKED and mark what they processed.
 * Access is also enforced on every request, so a late tick never extends anyone's access.
 */
export async function schedulerTick(db: Db, cfg: Config, mailer: Mailer, log: (m: string) => void = console.log): Promise<TickResult> {
  const { rows: expired } = await db.query<{ expired_user_id: string; expired_email: string; expired_at: Date }>(
    `SELECT * FROM app.expire_due_accounts()`);
  for (const e of expired) await sendSafely(mailer, emails.expired(e.expired_email), log);

  if (expired.length) {
    const { rows } = await db.query<{ email: string | null }>(
      `SELECT coalesce(s.admin_notify_email, (SELECT email_display FROM users WHERE role = 'admin')) AS email FROM platform_settings s`);
    const to = rows[0]?.email;
    if (to) await sendSafely(mailer, emails.adminExpired(to, expired.map((e) => e.expired_email)), log);
  }

  const { rows: warnings } = await db.query<{ warn_email: string; warn_expires_at: Date; warn_timezone: string }>(
    `SELECT * FROM app.claim_expiry_warnings()`);
  for (const w of warnings) await sendSafely(mailer, emails.expiringSoon(w.warn_email, w.warn_expires_at, w.warn_timezone), log);

  const mailboxRetries = await retryMailboxes(db, cfg, mailer, log);

  const { rows: pr } = await db.query<{ r: Record<string, number> }>(`SELECT app.prune_operational_data() AS r`);
  await db.query(`SELECT app.prune_change_feed()`);
  const reminders = await fireReminders(db).catch((err: Error) => { log(`reminders failed: ${err.message}`); return 0; });
  let storage: StorageHousekeeping | null = null;
  try {
    storage = await storageHousekeeping(cfg, db, log);
  } catch (err) {
    log(`storage housekeeping failed: ${(err as Error).message}`);
  }
  await db.query(`SELECT app.beat('scheduler')`).catch(() => undefined);
  if (expired.length || warnings.length) log(`scheduler: expired ${expired.length}, warned ${warnings.length}`);
  return { expired: expired.length, warned: warnings.length, mailboxRetries, pruned: pr[0]?.r ?? {}, storage, reminders };
}
