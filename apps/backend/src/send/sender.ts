import type { Config } from '../lib/config.js';
import { withUser, type Db, type Tx } from '../lib/db.js';
import { mailError } from '../mail/errors.js';
import { createImapClient } from '../mail/imap.js';
import { createSmtpTransport } from '../mail/smtp.js';
import { getMailbox, loadSecrets, pinsOf, recordFailure, settingsOf, type MailboxRow } from '../mailboxes/repo.js';
import { enqueueProblem } from '../push/notify.js';

/** Delays before automatic retries of temporary failures (then the message is marked failed). */
export const RETRY_DELAYS_SECONDS = [60, 300, 900, 1800, 3600];

export type SendOutcome = 'sent' | 'retry' | 'failed' | 'uncertain' | 'deferred' | 'skipped';

interface OutboundRow {
  id: string;
  user_id: string;
  mailbox_id: string;
  message_id_header: string;
  compose_kind: string;
  source_message_id: string | null;
  status: string;
  attempt_count: number;
  recipient_count: number;
}

interface SmtpError {
  responseCode?: number;
  response?: string;
  command?: string;
  code?: string;
  message: string;
}

/**
 * Classifies a submission failure. The key question is whether the server might already have accepted
 * the message: if the connection broke after the message body was transmitted but before the final
 * reply, nobody knows. Such messages become "uncertain" and are never retried automatically.
 */
export function classifySendError(err: SmtpError): { kind: 'temp' | 'perm' | 'uncertain' | 'auth'; code: string; text: string } {
  const text = (err.response ?? err.message ?? '').slice(0, 500);
  if (err.responseCode === 535 || err.code === 'EAUTH') return { kind: 'auth', code: 'AUTH_FAILED', text };
  if (err.responseCode && err.responseCode >= 500) return { kind: 'perm', code: `SMTP_${err.responseCode}`, text };
  if (err.responseCode && err.responseCode >= 400) return { kind: 'temp', code: `SMTP_${err.responseCode}`, text };
  if (err.command === 'DATA' || err.command === 'end of data' || err.code === 'EMESSAGE') {
    return { kind: 'uncertain', code: 'CONNECTION_LOST_DURING_SEND', text };
  }
  return { kind: 'temp', code: err.code ?? 'CONNECTION_ERROR', text };
}

async function loadOutbound(c: Tx, id: string) {
  const { rows } = await c.query<OutboundRow>(`SELECT * FROM outbound_messages WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

async function finish(c: Tx, id: string, set: Record<string, unknown>) {
  const keys = Object.keys(set);
  await c.query(`UPDATE outbound_messages SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, lease_until = NULL WHERE id = $1`,
    [id, ...keys.map((k) => set[k])]);
}

/** Saves a copy in the mailbox's Sent folder (unless the provider does it itself) and marks the original answered. */
async function afterSent(cfg: Config, db: Db, userId: string, m: MailboxRow, o: OutboundRow, mime: Buffer, password: string, log: (s: string) => void) {
  const { sentPath, source } = await withUser(db, userId, async (c) => {
    const f = await c.query<{ path: string }>(`SELECT path FROM folders WHERE mailbox_id = $1 AND special_use = 'sent' AND exists_on_server`, [m.id]);
    const s = o.source_message_id ? await c.query<{ path: string; uid: string }>(
      `SELECT f.path, l.uid FROM message_locations l JOIN folders f ON f.id = l.folder_id WHERE l.message_id = $1 LIMIT 1`, [o.source_message_id]) : null;
    return { sentPath: f.rows[0]?.path ?? null, source: s?.rows[0] ?? null };
  });
  const needCopy = !m.provider_saves_sent;
  if (!needCopy && !source) {
    await withUser(db, userId, (c) => finish(c, o.id, { sent_copy_state: 'not_needed' }));
    return;
  }
  const client = await createImapClient(cfg, settingsOf(m).imap, password, pinsOf(m).imap);
  client.on('error', () => undefined);
  let copyState = needCopy ? 'failed' : 'not_needed';
  try {
    await client.connect();
    if (needCopy) {
      if (sentPath) {
        await client.append(sentPath, mime, ['\\Seen']);
        copyState = 'appended';
      } else {
        log(`no Sent folder known for ${m.email_address}; sent copy not saved on the server`);
      }
    }
    if (source) {
      const lock = await client.getMailboxLock(source.path);
      try {
        await client.messageFlagsAdd(source.uid, [o.compose_kind === 'forward' ? '$Forwarded' : '\\Answered'], { uid: true });
      } finally {
        lock.release();
      }
      await withUser(db, userId, (c) => c.query(
        `UPDATE messages SET ${o.compose_kind === 'forward' ? 'is_forwarded' : 'is_answered'} = true WHERE id = $1`, [o.source_message_id]));
    }
  } catch (err) {
    log(`after-send IMAP step failed for ${o.id}: ${(err as Error).message}`);
  } finally {
    await client.logout().catch(() => client.close());
  }
  await withUser(db, userId, (c) => finish(c, o.id, { sent_copy_state: copyState }));
}

/**
 * Submits one claimed message (status 'sending'). The attempt is recorded and committed BEFORE the
 * SMTP conversation starts, so even a crash leaves evidence; the fixed Message-ID makes any later
 * manual resend recognisable as the same message.
 */
export async function sendClaimed(cfg: Config, db: Db, userId: string, outboundId: string, log: (s: string) => void = console.log): Promise<SendOutcome> {
  const prep = await withUser(db, userId, async (c) => {
    const o = await loadOutbound(c, outboundId);
    if (!o || o.status !== 'sending') return null;
    const m = await getMailbox(c, o.mailbox_id);
    const secrets = m ? await loadSecrets(c, cfg, o.mailbox_id) : null;
    if (!m || !secrets) {
      await finish(c, o.id, { status: 'failed', last_error_code: 'MAILBOX_UNAVAILABLE', last_error_message: 'The sending mailbox is disconnected or has no saved password.' });
      return null;
    }
    // Provider sending limit: wait instead of failing.
    const { rows: rate } = await c.query<{ n: number; oldest: Date | null }>(
      `SELECT count(*)::int AS n, min(sent_at) AS oldest FROM outbound_messages WHERE mailbox_id = $1 AND status = 'sent' AND sent_at > now() - interval '1 hour'`, [m.id]);
    const limit = m.send_limit_per_hour ?? 100;
    if ((rate[0]?.n ?? 0) + 1 > limit) {
      const wait = rate[0]?.oldest ? new Date(rate[0].oldest.getTime() + 3600_000) : new Date(Date.now() + 600_000);
      await finish(c, o.id, { status: 'queued', next_attempt_at: wait, last_error_code: 'RATE_LIMIT',
        last_error_message: `Waiting: this mailbox may send ${limit} messages per hour.` });
      return 'deferred' as const;
    }
    const { rows: mime } = await c.query<{ mime: Buffer }>(`SELECT mime FROM outbound_mime WHERE outbound_id = $1`, [o.id]);
    const { rows: rcpt } = await c.query<{ address: string }>(`SELECT address FROM outbound_recipients WHERE outbound_id = $1 ORDER BY kind, position`, [o.id]);
    // attempt_count drives the automatic retry schedule (reset by a manual retry); attempt_no numbers every attempt ever made.
    const { rows: last } = await c.query<{ n: number }>(`SELECT coalesce(max(attempt_no), 0)::int AS n FROM delivery_attempts WHERE outbound_id = $1`, [o.id]);
    const attemptNo = (last[0]?.n ?? 0) + 1;
    await c.query(`INSERT INTO delivery_attempts (outbound_id, user_id, attempt_no) VALUES ($1, $2, $3)`, [o.id, userId, attemptNo]);
    await c.query(`UPDATE outbound_messages SET attempt_count = attempt_count + 1 WHERE id = $1`, [o.id]);
    return { o: { ...o, attempt_count: o.attempt_count + 1 }, m, secrets, mime: mime[0]!.mime, recipients: rcpt.map((r) => r.address), attemptNo };
  });
  if (prep === null) return 'skipped';
  if (prep === 'deferred') return 'deferred';
  const { o, m, secrets, mime, recipients, attemptNo } = prep;

  const recordAttempt = (c: Tx, outcome: string, code: number | null, text: string | null) => c.query(
    `UPDATE delivery_attempts SET finished_at = now(), outcome = $3, smtp_code = $4, response_text = $5 WHERE outbound_id = $1 AND attempt_no = $2`,
    [o.id, attemptNo, outcome, code, text?.slice(0, 500) ?? null]);

  let transport;
  try {
    transport = await createSmtpTransport(cfg, settingsOf(m).smtp, secrets.smtpPassword || secrets.imapPassword, pinsOf(m).smtp);
  } catch (err) {
    // Could not even resolve/prepare the connection: nothing was transmitted.
    await withUser(db, userId, async (c) => {
      await recordAttempt(c, 'temp_failure', null, (err as Error).message);
      await scheduleRetry(c, o, 'CONNECTION_ERROR', (err as Error).message);
    });
    return 'retry';
  }
  try {
    const info = await transport.sendMail({ envelope: { from: m.email_address, to: recipients }, raw: mime });
    await withUser(db, userId, async (c) => {
      await recordAttempt(c, 'accepted', 250, info.response ?? null);
      await finish(c, o.id, { status: 'sent', sent_at: new Date(), provider_response: (info.response ?? '').slice(0, 500), last_error_code: null, last_error_message: null });
    });
    await afterSent(cfg, db, userId, m, o, mime, secrets.imapPassword, log).catch((e: Error) => log(`after-send failed: ${e.message}`));
    return 'sent';
  } catch (err) {
    const e = err as SmtpError;
    const k = classifySendError(e);
    return withUser(db, userId, async (c) => {
      if (k.kind === 'uncertain') {
        await recordAttempt(c, 'uncertain', null, k.text);
        await finish(c, o.id, { status: 'uncertain', last_error_code: k.code,
          last_error_message: 'The connection was lost while the message was being sent. It may or may not have been delivered; check before sending again.' });
        await enqueueProblem(c, userId, 'send_problem', `send:${o.id}:uncertain`, `Check a message sent from ${m.email_address}`, { type: 'send_problem', outboundId: o.id }, m.id);
        return 'uncertain' as const;
      }
      if (k.kind === 'temp') {
        await recordAttempt(c, 'temp_failure', e.responseCode ?? null, k.text);
        return (await scheduleRetry(c, o, k.code, k.text)) ? 'retry' as const : 'failed' as const;
      }
      await recordAttempt(c, 'perm_failure', e.responseCode ?? null, k.text);
      if (k.kind === 'auth') await recordFailure(c, m, mailError('AUTH_FAILED', 'smtp', m.smtp_host, m.smtp_port));
      await enqueueProblem(c, userId, 'send_problem', `send:${o.id}:failed`, `A message from ${m.email_address} could not be sent`, { type: 'send_problem', outboundId: o.id }, m.id);
      await finish(c, o.id, { status: 'failed', last_error_code: k.code,
        last_error_message: k.kind === 'auth'
          ? 'The mail server rejected the mailbox password. Update it in the mailbox settings, then retry.'
          : `The mail server refused the message: ${k.text}` });
      return 'failed' as const;
    });
  } finally {
    transport.close();
  }
}

async function scheduleRetry(c: Tx, o: OutboundRow, code: string, text: string): Promise<boolean> {
  const delay = RETRY_DELAYS_SECONDS[o.attempt_count - 1];
  if (delay === undefined) {
    await enqueueProblem(c, o.user_id, 'send_problem', `send:${o.id}:failed`, 'A message could not be sent', { type: 'send_problem', outboundId: o.id }, o.mailbox_id);
    await finish(c, o.id, { status: 'failed', last_error_code: code, last_error_message: `Gave up after ${o.attempt_count} attempts: ${text}`.slice(0, 500) });
    return false;
  }
  await finish(c, o.id, { status: 'queued', next_attempt_at: new Date(Date.now() + delay * 1000), last_error_code: code,
    last_error_message: `Temporary problem, retrying automatically: ${text}`.slice(0, 500) });
  return true;
}

/** Background pass: sends everything that is due, within the time budget. */
export async function runSendPass(cfg: Config, db: Db, budgetMs: number, log: (s: string) => void = console.log) {
  const deadline = Date.now() + budgetMs;
  const results: SendOutcome[] = [];
  while (Date.now() < deadline - 3000) {
    const { rows } = await db.query<{ claim_id: string; claim_user_id: string }>(`SELECT * FROM app.claim_outbound(5, 180)`);
    if (!rows.length) break;
    for (const r of rows) {
      try {
        results.push(await sendClaimed(cfg, db, r.claim_user_id, r.claim_id, log));
      } catch (err) {
        log(`send ${r.claim_id} crashed: ${(err as Error).message}`);
      }
    }
  }
  return results;
}
