import { X509Certificate } from 'node:crypto';
import { credentialKey } from '../admin/mfa.js';
import type { Config } from '../lib/config.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import type { Tx } from '../lib/db.js';
import { iso } from '../lib/account.js';
import type { MailError } from '../mail/errors.js';
import type { MailboxSettings, Pins, Secrets } from '../mail/settings.js';
import type { VerifiedMailbox } from '../mail/connect.js';

export const MAX_MAILBOXES_PER_USER = 50;

export interface MailboxRow {
  id: string;
  user_id: string;
  email_address: string;
  display_name: string | null;
  label_color: string | null;
  provider: string;
  status: 'active' | 'auth_failed' | 'error' | 'paused_account' | 'disconnected';
  status_detail: string | null;
  last_error_code: string | null;
  last_error_at: Date | null;
  consecutive_failures: number;
  next_retry_at: Date | null;
  generation: number;
  capabilities: Record<string, unknown>;
  max_message_bytes: number | null;
  last_verified_at: Date | null;
  last_incoming_at: Date | null;
  last_full_sync_at: Date | null;
  created_at: Date;
  disconnected_at: Date | null;
  sync_window_days: number;
  provider_saves_sent: boolean;
  send_limit_per_hour: number | null;
  max_recipients_per_msg: number | null;
  next_sync_at: Date | null;
  initial_sync_done: boolean;
  imap_host: string;
  imap_port: number;
  imap_security: 'tls' | 'starttls';
  imap_username: string;
  smtp_host: string;
  smtp_port: number;
  smtp_security: 'tls' | 'starttls';
  smtp_username: string;
  imap_cert_sha256: string | null;
  imap_cert_pem: string | null;
  smtp_cert_sha256: string | null;
  smtp_cert_pem: string | null;
  discovered_via: string;
}

const SELECT = `SELECT m.*, s.imap_host, s.imap_port, s.imap_security, s.imap_username, s.smtp_host, s.smtp_port,
                       s.smtp_security, s.smtp_username, s.imap_cert_sha256, s.imap_cert_pem, s.smtp_cert_sha256,
                       s.smtp_cert_pem, s.discovered_via
                  FROM mailboxes m LEFT JOIN mailbox_server_settings s ON s.mailbox_id = m.id`;

export async function listMailboxes(c: Tx): Promise<MailboxRow[]> {
  const { rows } = await c.query<MailboxRow>(`${SELECT} ORDER BY m.created_at`);
  return rows;
}

export async function getMailbox(c: Tx, id: string, forUpdate = false): Promise<MailboxRow | null> {
  const { rows } = await c.query<MailboxRow>(`${SELECT} WHERE m.id = $1 ${forUpdate ? 'FOR UPDATE OF m' : ''}`, [id]);
  return rows[0] ?? null;
}

export function settingsOf(m: MailboxRow): MailboxSettings {
  return {
    imap: { host: m.imap_host, port: m.imap_port, security: m.imap_security, username: m.imap_username },
    smtp: { host: m.smtp_host, port: m.smtp_port, security: m.smtp_security, username: m.smtp_username },
  };
}

export function pinsOf(m: MailboxRow): Pins {
  return {
    imap: m.imap_cert_sha256 && m.imap_cert_pem ? { sha256: m.imap_cert_sha256, pem: m.imap_cert_pem } : null,
    smtp: m.smtp_cert_sha256 && m.smtp_cert_pem ? { sha256: m.smtp_cert_sha256, pem: m.smtp_cert_pem } : null,
  };
}

/** Validates a certificate the user chose to trust: the PEM must parse and match its fingerprint. */
export function validatePin(pin: { sha256: string; pem: string } | undefined | null) {
  if (!pin) return null;
  try {
    const x = new X509Certificate(pin.pem);
    return x.fingerprint256 === pin.sha256 ? { sha256: pin.sha256, pem: x.toString() } : null;
  } catch {
    return null;
  }
}

export async function loadSecrets(c: Tx, cfg: Config, mailboxId: string): Promise<Secrets | null> {
  const { rows } = await c.query<{ imap_secret_enc: Buffer; smtp_secret_enc: Buffer | null }>(
    `SELECT imap_secret_enc, smtp_secret_enc FROM mailbox_credentials WHERE mailbox_id = $1`, [mailboxId]);
  const r = rows[0];
  if (!r) return null;
  const key = credentialKey(cfg);
  return {
    imapPassword: decryptSecret(key, r.imap_secret_enc, `mailbox:${mailboxId}:imap`),
    smtpPassword: r.smtp_secret_enc ? decryptSecret(key, r.smtp_secret_enc, `mailbox:${mailboxId}:smtp`) : null,
  };
}

async function writeSecrets(c: Tx, cfg: Config, userId: string, mailboxId: string, secrets: Secrets) {
  const key = credentialKey(cfg);
  const smtpDifferent = secrets.smtpPassword && secrets.smtpPassword !== secrets.imapPassword;
  await c.query(
    `INSERT INTO mailbox_credentials (mailbox_id, user_id, imap_secret_enc, smtp_secret_enc)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (mailbox_id) DO UPDATE SET imap_secret_enc = EXCLUDED.imap_secret_enc,
            smtp_secret_enc = EXCLUDED.smtp_secret_enc, updated_at = now()`,
    [mailboxId, userId, encryptSecret(key, secrets.imapPassword, `mailbox:${mailboxId}:imap`),
     smtpDifferent ? encryptSecret(key, secrets.smtpPassword!, `mailbox:${mailboxId}:smtp`) : null]);
}

async function writeSettings(c: Tx, userId: string, mailboxId: string, v: VerifiedMailbox, pins: Pins) {
  const s = v.settings;
  await c.query(
    `INSERT INTO mailbox_server_settings (mailbox_id, user_id, imap_host, imap_port, imap_security, imap_username,
            smtp_host, smtp_port, smtp_security, smtp_username, imap_cert_sha256, imap_cert_pem, smtp_cert_sha256,
            smtp_cert_pem, discovered_via)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (mailbox_id) DO UPDATE SET imap_host = EXCLUDED.imap_host, imap_port = EXCLUDED.imap_port,
            imap_security = EXCLUDED.imap_security, imap_username = EXCLUDED.imap_username, smtp_host = EXCLUDED.smtp_host,
            smtp_port = EXCLUDED.smtp_port, smtp_security = EXCLUDED.smtp_security, smtp_username = EXCLUDED.smtp_username,
            imap_cert_sha256 = EXCLUDED.imap_cert_sha256, imap_cert_pem = EXCLUDED.imap_cert_pem,
            smtp_cert_sha256 = EXCLUDED.smtp_cert_sha256, smtp_cert_pem = EXCLUDED.smtp_cert_pem,
            discovered_via = EXCLUDED.discovered_via, updated_at = now()`,
    [mailboxId, userId, s.imap.host, s.imap.port, s.imap.security, s.imap.username, s.smtp.host, s.smtp.port,
     s.smtp.security, s.smtp.username, pins.imap?.sha256 ?? null, pins.imap?.pem ?? null, pins.smtp?.sha256 ?? null,
     pins.smtp?.pem ?? null, v.discoveredVia]);
}

function capabilitiesOf(v: VerifiedMailbox) {
  return { imap: v.imap.capabilities, specialUse: v.imap.folders.filter((f) => f.specialUse).map((f) => f.specialUse) };
}

export async function insertMailbox(
  c: Tx, cfg: Config, userId: string, email: string, displayName: string | null, v: VerifiedMailbox, secrets: Secrets, pins: Pins,
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO mailboxes (user_id, email_address, display_name, capabilities, max_message_bytes, last_verified_at,
            provider_saves_sent)
     VALUES ($1, $2, $3, $4, $5, now(), $6) RETURNING id`,
    [userId, email, displayName, JSON.stringify(capabilitiesOf(v)), v.maxMessageBytes,
     /gmail|office365|outlook/.test(v.settings.smtp.host)]);
  const id = rows[0]!.id;
  await writeSettings(c, userId, id, v, pins);
  await writeSecrets(c, cfg, userId, id, secrets);
  await c.query(`INSERT INTO mailbox_events (user_id, mailbox_id, category, severity, code, detail)
                 VALUES ($1, $2, 'connection', 'info', 'CONNECTED', $3)`,
    [userId, id, `Connected via ${v.settings.imap.host} and ${v.settings.smtp.host}`]);
  return id;
}

/** Stores new credentials and/or settings after a successful test, and resumes the mailbox. */
export async function updateVerified(c: Tx, cfg: Config, m: MailboxRow, v: VerifiedMailbox, secrets: Secrets, pins: Pins) {
  await writeSettings(c, m.user_id, m.id, v, pins);
  await writeSecrets(c, cfg, m.user_id, m.id, secrets);
  await c.query(
    `UPDATE mailboxes SET status = 'active', status_detail = NULL, last_error_code = NULL, consecutive_failures = 0,
            next_retry_at = NULL, generation = generation + 1, capabilities = $2, max_message_bytes = $3, last_verified_at = now()
      WHERE id = $1`, [m.id, JSON.stringify(capabilitiesOf(v)), v.maxMessageBytes]);
  await c.query(`UPDATE mailbox_events SET resolved_at = now() WHERE mailbox_id = $1 AND resolved_at IS NULL`, [m.id]);
  await c.query(`INSERT INTO mailbox_events (user_id, mailbox_id, category, severity, code, detail)
                 VALUES ($1, $2, 'connection', 'info', 'RECONNECTED', 'Connection verified')`, [m.user_id, m.id]);
}

/** Exponential backoff with jitter: 30 s, 1 m, 2 m ... capped at 30 minutes. */
export function backoffSeconds(failures: number): number {
  const base = Math.min(30 * 2 ** Math.max(0, failures - 1), 1800);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * Records a failed connection. A rejected password stops all retries until the user enters a new one
 * (retrying a wrong password can get the mailbox locked). Other problems are retried with backoff.
 * Returns true when this failure newly requires the user's action.
 */
export async function recordFailure(c: Tx, m: MailboxRow, err: MailError): Promise<boolean> {
  if (err.code === 'AUTH_FAILED') {
    const wasAlready = m.status === 'auth_failed';
    await c.query(
      `UPDATE mailboxes SET status = 'auth_failed', status_detail = $2, last_error_code = $3, last_error_at = now(),
              next_retry_at = NULL WHERE id = $1`, [m.id, err.message.slice(0, 500), err.code]);
    if (!wasAlready) {
      await c.query(`INSERT INTO mailbox_events (user_id, mailbox_id, category, severity, code, detail)
                     VALUES ($1, $2, 'auth', 'action_required', $3, $4)`, [m.user_id, m.id, err.code, err.message.slice(0, 500)]);
    }
    return !wasAlready;
  }
  const failures = m.consecutive_failures + 1;
  await c.query(
    `UPDATE mailboxes SET status = 'error', status_detail = $2, last_error_code = $3, last_error_at = now(),
            consecutive_failures = $4, next_retry_at = now() + make_interval(secs => $5) WHERE id = $1`,
    [m.id, err.message.slice(0, 500), err.code, failures, backoffSeconds(failures)]);
  // Tell the user once a problem has lasted a while (about 6 failures ≈ 30+ minutes of retries).
  const needsAttention = failures === 6;
  await c.query(`INSERT INTO mailbox_events (user_id, mailbox_id, category, severity, code, detail)
                 VALUES ($1, $2, 'connection', $3, $4, $5)`,
    [m.user_id, m.id, needsAttention ? 'action_required' : 'warning', err.code, err.message.slice(0, 500)]);
  return needsAttention;
}

export async function recordSuccess(c: Tx, m: MailboxRow) {
  await c.query(
    `UPDATE mailboxes SET status = 'active', status_detail = NULL, last_error_code = NULL, consecutive_failures = 0,
            next_retry_at = NULL, last_verified_at = now() WHERE id = $1`, [m.id]);
  await c.query(`UPDATE mailbox_events SET resolved_at = now() WHERE mailbox_id = $1 AND resolved_at IS NULL AND category = 'connection'`, [m.id]);
}

export function toMailboxDto(m: MailboxRow) {
  return {
    id: m.id,
    email: m.email_address,
    displayName: m.display_name,
    labelColor: m.label_color,
    provider: m.provider,
    status: m.status,
    statusDetail: m.status_detail,
    lastErrorCode: m.last_error_code,
    lastErrorAt: iso(m.last_error_at),
    nextRetryAt: iso(m.next_retry_at),
    lastVerifiedAt: iso(m.last_verified_at),
    lastIncomingAt: iso(m.last_incoming_at),
    createdAt: m.created_at.toISOString(),
    disconnectedAt: iso(m.disconnected_at),
    maxMessageBytes: m.max_message_bytes,
    settings: m.imap_host ? {
      ...settingsOf(m),
      discoveredVia: m.discovered_via,
      trustedCertificate: { imap: !!m.imap_cert_sha256, smtp: !!m.smtp_cert_sha256 },
    } : null,
  };
}
