import type { Db } from './lib/db.js';
import { emails } from './lib/emails.js';
import { sendSafely, type Mailer } from './lib/mailer.js';

export interface TickResult {
  expired: number;
  warned: number;
  pruned: Record<string, number>;
}

/**
 * One scheduler pass. On cPanel this runs from cron every minute; on a server it can run in a loop.
 * Safe to run concurrently: the SQL functions lock rows with SKIP LOCKED and mark what they processed.
 * Access is also enforced on every request, so a late tick never extends anyone's access.
 */
export async function schedulerTick(db: Db, mailer: Mailer, log: (m: string) => void = console.log): Promise<TickResult> {
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

  const { rows: pr } = await db.query<{ r: Record<string, number> }>(`SELECT app.prune_operational_data() AS r`);
  if (expired.length || warnings.length) log(`scheduler: expired ${expired.length}, warned ${warnings.length}`);
  return { expired: expired.length, warned: warnings.length, pruned: pr[0]?.r ?? {} };
}
