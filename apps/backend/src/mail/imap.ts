import { ImapFlow } from 'imapflow';
import type { Config } from '../lib/config.js';
import { classify, mailError, MailError } from './errors.js';
import { resolveMailHost } from './net.js';
import type { Pins, ServerSettings } from './settings.js';
import { inspectCertificate, tlsOptions } from './tls.js';

export async function createImapClient(cfg: Config, s: ServerSettings, password: string, pin?: Pins['imap']): Promise<ImapFlow> {
  const target = await resolveMailHost(cfg, s.host, s.port, 'imap');
  return new ImapFlow({
    host: target.address,
    port: s.port,
    secure: s.security === 'tls',
    doSTARTTLS: s.security === 'starttls' ? true : undefined,
    servername: target.host,
    tls: tlsOptions(cfg, target, pin),
    auth: { user: s.username, pass: password },
    logger: false,
    connectionTimeout: cfg.mail.connectTimeoutMs,
    greetingTimeout: cfg.mail.connectTimeoutMs,
    socketTimeout: 5 * 60_000,
    disableAutoIdle: true,
    clientInfo: { name: 'Email Platform' },
  });
}

/** Converts a failed connection into a MailError, attaching the server certificate when TLS was the problem. */
export async function toMailError(cfg: Config, err: unknown, stage: 'imap' | 'smtp', s: ServerSettings): Promise<MailError> {
  if (err instanceof MailError) return err;
  const code = classify(err);
  let cert;
  if ((code === 'TLS_UNTRUSTED' || code === 'TLS_HOSTNAME_MISMATCH') && s.security === 'tls') {
    const target = await resolveMailHost(cfg, s.host, s.port, stage).catch(() => null);
    if (target) cert = await inspectCertificate(target);
  }
  return mailError(code, stage, s.host, s.port, cert);
}

export interface ImapTestResult {
  capabilities: string[];
  folders: Array<{ path: string; specialUse: string | null }>;
}

/** Logs in and lists folders. Never changes anything on the server. */
export async function testImap(cfg: Config, s: ServerSettings, password: string, pin?: Pins['imap']): Promise<ImapTestResult> {
  const client = await createImapClient(cfg, s, password, pin);
  client.on('error', () => undefined); // errors surface through the awaited calls
  try {
    await client.connect();
    const list = await client.list();
    const capabilities = [...client.capabilities.keys()];
    return { capabilities, folders: list.map((f) => ({ path: f.path, specialUse: f.specialUse ?? null })) };
  } catch (err) {
    throw await toMailError(cfg, err, 'imap', s);
  } finally {
    await client.logout().catch(() => client.close());
  }
}
