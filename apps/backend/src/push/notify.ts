import type { Config } from '../lib/config.js';
import { type Db, type Tx } from '../lib/db.js';
import { pushProvider, type PushMessage, type PushProvider } from './providers.js';

/** More new messages than this for one mailbox in one sync pass become a single "N new emails" notification. */
export const BURST_LIMIT = 5;

type PrefKey = 'new_mail' | 'send_problems' | 'mailbox_problems' | 'reminders';

async function devicesFor(c: Tx, pref: PrefKey, mailboxId: string | null) {
  const { rows } = await c.query<{ id: string }>(
    `SELECT d.id FROM devices d
      WHERE d.revoked_at IS NULL AND d.push_enabled AND d.push_token IS NOT NULL
        AND coalesce(
              (SELECT ${pref} FROM notification_preferences p WHERE p.mailbox_id = $1),
              (SELECT ${pref} FROM notification_preferences p WHERE p.mailbox_id IS NULL),
              true)`, [mailboxId]);
  return rows.map((r) => r.id);
}

async function enqueue(c: Tx, userId: string, devices: string[], n: { kind: string; dedupe: string; title: string; body?: string | null; data: Record<string, unknown> }) {
  for (const device of devices) {
    await c.query(
      `INSERT INTO notification_outbox (user_id, device_id, kind, dedupe_key, title, body, data) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (device_id, dedupe_key) DO NOTHING`,
      [userId, device, n.kind, n.dedupe, n.title, n.body ?? null, JSON.stringify(n.data)]);
  }
}

/**
 * New mail: "New email received at sales@company.com" — the receiving address only, never the sender or
 * subject (notifications can be read on a locked screen). One per message per device; bursts are collapsed.
 */
export async function enqueueNewMail(c: Tx, userId: string, mailboxId: string, mailboxEmail: string, messageIds: string[]) {
  if (!messageIds.length) return;
  const devices = await devicesFor(c, 'new_mail', mailboxId);
  if (!devices.length) return;
  if (messageIds.length > BURST_LIMIT) {
    await enqueue(c, userId, devices, {
      kind: 'new_mail', dedupe: `new_mail_burst:${messageIds[0]}`,
      title: `${messageIds.length} new emails received at ${mailboxEmail}`,
      data: { type: 'new_mail', mailboxId, count: messageIds.length },
    });
    return;
  }
  for (const id of messageIds) {
    await enqueue(c, userId, devices, {
      kind: 'new_mail', dedupe: `new_mail:${id}`, title: `New email received at ${mailboxEmail}`,
      data: { type: 'new_mail', mailboxId, messageId: id },
    });
  }
}

export async function enqueueProblem(c: Tx, userId: string, kind: 'send_problem' | 'mailbox_problem' | 'reminder' | 'account', dedupe: string,
  title: string, data: Record<string, unknown>, mailboxId: string | null = null) {
  const pref: PrefKey = kind === 'send_problem' ? 'send_problems' : kind === 'mailbox_problem' ? 'mailbox_problems' : kind === 'reminder' ? 'reminders' : 'new_mail';
  const devices = kind === 'account' ? await allDevices(c) : await devicesFor(c, pref, mailboxId);
  await enqueue(c, userId, devices, { kind, dedupe, title, data });
}

async function allDevices(c: Tx) {
  const { rows } = await c.query<{ id: string }>(`SELECT id FROM devices WHERE revoked_at IS NULL AND push_enabled AND push_token IS NOT NULL`);
  return rows.map((r) => r.id);
}

/** Sends pending notifications. Retries up to 3 times; tokens reported as unregistered are switched off. */
export async function dispatchNotifications(cfg: Config, db: Db, log: (m: string) => void = console.log,
  providers: Partial<Record<'expo' | 'fcm' | 'webpush', PushProvider | null>> = {}): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  // One round per call: notifications that failed temporarily are retried on the next run, not immediately.
  {
    const { rows } = await db.query<{ n_id: number; n_token: string | null; n_provider: 'expo' | 'fcm' | 'webpush' | null; n_title: string; n_body: string | null;
                                       n_data: Record<string, unknown>; n_kind: string; n_attempts: number }>(`SELECT * FROM app.claim_notifications(500)`);
    const byProvider = new Map<'expo' | 'fcm' | 'webpush', typeof rows>();
    for (const r of rows) {
      const p = r.n_provider ?? 'expo';
      byProvider.set(p, [...(byProvider.get(p) ?? []), r]);
    }
    for (const [p, list] of byProvider) {
      const provider = p in providers ? providers[p] ?? null : pushProvider(cfg, p);
      if (!provider) {
        for (const r of list) await db.query(`SELECT app.finish_notification($1, 'dropped', 'push not configured', false)`, [r.n_id]);
        continue;
      }
      const messages: PushMessage[] = list.map((r) => ({
        token: r.n_token!, title: r.n_title, body: r.n_body, data: r.n_data,
        group: typeof r.n_data.mailboxId === 'string' ? `mailbox-${r.n_data.mailboxId}` : undefined,
      }));
      let results;
      try {
        results = await provider.send(messages);
      } catch (err) {
        results = messages.map(() => ({ ok: false, disableToken: false, error: (err as Error).message }));
      }
      for (const [i, r] of list.entries()) {
        const res = results[i]!;
        const status = res.ok ? 'sent' : res.disableToken || r.n_attempts >= 3 ? 'failed' : 'pending';
        if (res.ok) sent++; else if (status === 'failed') failed++;
        await db.query(`SELECT app.finish_notification($1, $2, $3, $4)`, [r.n_id, status, res.error ?? null, res.disableToken]);
      }
      if (results.some((x) => !x.ok)) log(`push: ${results.filter((x) => !x.ok).length} of ${results.length} not delivered to ${p}`);
    }
  }
  return { sent, failed };
}
