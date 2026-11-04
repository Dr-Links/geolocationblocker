import type { Config } from '../lib/config.js';
import { discover, type DiscoveryDeps, type DiscoverySource, type ProviderHint } from './discovery.js';
import { MailError, type MailErrorCode } from './errors.js';
import { testImap, type ImapTestResult } from './imap.js';
import type { MailboxSettings, Pins, Secrets, ServerSettings } from './settings.js';
import { testSmtp } from './smtp.js';

export interface VerifiedMailbox {
  settings: MailboxSettings;
  discoveredVia: DiscoverySource | 'manual';
  imap: ImapTestResult;
  maxMessageBytes: number | null;
  hint?: ProviderHint;
}

export class ConnectFailure extends Error {
  constructor(public readonly error: MailError, public readonly hint?: ProviderHint, public readonly triedAutomatic = false) {
    super(error.message);
  }
}

// When several candidates fail, report the most useful reason.
const PRIORITY: MailErrorCode[] = ['AUTH_FAILED', 'TLS_HOSTNAME_MISMATCH', 'TLS_UNTRUSTED', 'STARTTLS_UNAVAILABLE', 'TLS_FAILED',
  'PROTOCOL_ERROR', 'CONNECT_REFUSED', 'CONNECT_TIMEOUT', 'BLOCKED_ADDRESS', 'PORT_NOT_ALLOWED', 'HOST_NOT_FOUND', 'UNKNOWN', 'SEND_REJECTED'];
const best = (errors: MailError[]) => [...errors].sort((a, b) => PRIORITY.indexOf(a.code) - PRIORITY.indexOf(b.code))[0]!;

/** For an outgoing server that does not answer on 465, also try 587 with STARTTLS (and vice versa). */
function smtpVariants(s: ServerSettings): ServerSettings[] {
  if (s.port === 465) return [s, { ...s, port: 587, security: 'starttls' }];
  if (s.port === 587) return [s, { ...s, port: 465, security: 'tls' }];
  return [s];
}

/**
 * Finds and verifies working IMAP and SMTP settings. With `manual` settings only those are tested.
 * Stops immediately when the server rejects the password: trying more servers would not help, and
 * repeated failed logins can get the mailbox blocked by the hosting provider's brute-force protection.
 */
export async function verifyMailbox(
  cfg: Config,
  email: string,
  secrets: Secrets,
  opts: { manual?: MailboxSettings; pins?: Pins; deps: DiscoveryDeps },
): Promise<VerifiedMailbox> {
  const smtpPassword = secrets.smtpPassword || secrets.imapPassword;

  if (opts.manual) {
    let imap: ImapTestResult;
    try {
      imap = await testImap(cfg, opts.manual.imap, secrets.imapPassword, opts.pins?.imap);
    } catch (err) {
      throw new ConnectFailure(err as MailError);
    }
    try {
      const smtp = await testSmtp(cfg, opts.manual.smtp, smtpPassword, opts.pins?.smtp);
      return { settings: opts.manual, discoveredVia: 'manual', imap, maxMessageBytes: smtp.maxMessageBytes };
    } catch (err) {
      throw new ConnectFailure(err as MailError);
    }
  }

  const { candidates, hint } = await discover(email, opts.deps);
  if (hint?.requiresOAuth) {
    throw new ConnectFailure(new MailError('AUTH_FAILED',
      `${hint.name} mailboxes require signing in with Microsoft, which arrives in a later update. Password sign-in is no longer accepted by Microsoft.`, 'imap'), hint, true);
  }
  const deadline = Date.now() + 90_000;

  // 1. Incoming server.
  const imapErrors: MailError[] = [];
  let found: { candidate: (typeof candidates)[number]; imap: ImapTestResult } | null = null;
  const triedImap = new Set<string>();
  for (const c of candidates) {
    const key = `${c.settings.imap.host}:${c.settings.imap.port}`;
    if (triedImap.has(key) || Date.now() > deadline) continue;
    triedImap.add(key);
    try {
      found = { candidate: c, imap: await testImap(cfg, c.settings.imap, secrets.imapPassword, opts.pins?.imap) };
      break;
    } catch (err) {
      const e = err as MailError;
      imapErrors.push(e);
      if (e.code === 'AUTH_FAILED') break;
    }
  }
  if (!found) throw new ConnectFailure(best(imapErrors.length ? imapErrors : [new MailError('HOST_NOT_FOUND', 'No incoming mail server could be found for this address. Enter the settings manually.', 'imap')]), hint, true);

  // 2. Outgoing server: same source first, then the others.
  const ordered = [found.candidate, ...candidates.filter((c) => c !== found!.candidate)];
  const smtpErrors: MailError[] = [];
  const triedSmtp = new Set<string>();
  for (const c of ordered) {
    for (const s of smtpVariants(c.settings.smtp)) {
      const key = `${s.host}:${s.port}`;
      if (triedSmtp.has(key) || Date.now() > deadline) continue;
      triedSmtp.add(key);
      try {
        const smtp = await testSmtp(cfg, s, smtpPassword, opts.pins?.smtp);
        return {
          settings: { imap: found.candidate.settings.imap, smtp: s },
          discoveredVia: found.candidate.source,
          imap: found.imap,
          maxMessageBytes: smtp.maxMessageBytes,
          hint,
        };
      } catch (err) {
        const e = err as MailError;
        smtpErrors.push(e);
        if (e.code === 'AUTH_FAILED') throw new ConnectFailure(e, hint, true);
      }
    }
  }
  throw new ConnectFailure(best(smtpErrors), hint, true);
}
