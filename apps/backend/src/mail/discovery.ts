import { resolveMx, resolveSrv } from 'node:dns/promises';
import type { Config } from '../lib/config.js';
import { resolveMailHost } from './net.js';
import type { MailboxSettings, Security, ServerSettings } from './settings.js';

export type DiscoverySource = 'provider' | 'mx' | 'autoconfig' | 'ispdb' | 'srv' | 'guess';

export interface Candidate {
  source: DiscoverySource;
  settings: MailboxSettings;
  provider?: string;
}

export interface ProviderHint {
  name: string;
  /** e.g. Gmail and Yahoo refuse normal passwords for IMAP. */
  requiresAppPassword?: boolean;
  /** Basic passwords no longer work at all (Microsoft). */
  requiresOAuth?: boolean;
  helpUrl?: string;
}

export interface DiscoveryResult {
  candidates: Candidate[];
  hint?: ProviderHint;
}

interface KnownProvider extends ProviderHint {
  domains?: string[];
  mxSuffixes?: string[];
  imap: [string, number, Security];
  smtp: [string, number, Security];
}

// Well-known providers. MX suffixes catch custom domains hosted there (e.g. Google Workspace, Hostinger email).
const PROVIDERS: KnownProvider[] = [
  { name: 'Gmail / Google Workspace', domains: ['gmail.com', 'googlemail.com'], mxSuffixes: ['google.com', 'googlemail.com'],
    imap: ['imap.gmail.com', 993, 'tls'], smtp: ['smtp.gmail.com', 465, 'tls'], requiresAppPassword: true,
    helpUrl: 'https://support.google.com/accounts/answer/185833' },
  { name: 'Microsoft Outlook / 365', domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'], mxSuffixes: ['protection.outlook.com'],
    imap: ['outlook.office365.com', 993, 'tls'], smtp: ['smtp.office365.com', 587, 'starttls'], requiresOAuth: true },
  { name: 'Hostinger Email', mxSuffixes: ['hostinger.com'], imap: ['imap.hostinger.com', 993, 'tls'], smtp: ['smtp.hostinger.com', 465, 'tls'] },
  { name: 'Titan Email', mxSuffixes: ['titan.email'], imap: ['imap.titan.email', 993, 'tls'], smtp: ['smtp.titan.email', 465, 'tls'] },
  { name: 'Yahoo Mail', domains: ['yahoo.com', 'ymail.com', 'rocketmail.com'], mxSuffixes: ['yahoodns.net'],
    imap: ['imap.mail.yahoo.com', 993, 'tls'], smtp: ['smtp.mail.yahoo.com', 465, 'tls'], requiresAppPassword: true },
  { name: 'AOL Mail', domains: ['aol.com'], imap: ['imap.aol.com', 993, 'tls'], smtp: ['smtp.aol.com', 465, 'tls'], requiresAppPassword: true },
  { name: 'iCloud Mail', domains: ['icloud.com', 'me.com', 'mac.com'], mxSuffixes: ['icloud.com'],
    imap: ['imap.mail.me.com', 993, 'tls'], smtp: ['smtp.mail.me.com', 587, 'starttls'], requiresAppPassword: true },
  { name: 'Zoho Mail', domains: ['zoho.com', 'zohomail.com'], mxSuffixes: ['zoho.com'], imap: ['imap.zoho.com', 993, 'tls'], smtp: ['smtp.zoho.com', 465, 'tls'] },
  { name: 'Zoho Mail (EU)', mxSuffixes: ['zoho.eu'], imap: ['imap.zoho.eu', 993, 'tls'], smtp: ['smtp.zoho.eu', 465, 'tls'] },
  { name: 'GoDaddy Email', mxSuffixes: ['secureserver.net'], imap: ['imap.secureserver.net', 993, 'tls'], smtp: ['smtpout.secureserver.net', 465, 'tls'] },
  { name: 'Namecheap Private Email', mxSuffixes: ['privateemail.com'], imap: ['mail.privateemail.com', 993, 'tls'], smtp: ['mail.privateemail.com', 465, 'tls'] },
  { name: 'Fastmail', domains: ['fastmail.com', 'fastmail.fm'], mxSuffixes: ['messagingengine.com'], imap: ['imap.fastmail.com', 993, 'tls'], smtp: ['smtp.fastmail.com', 465, 'tls'] },
];

export interface DiscoveryDeps {
  resolveMx(domain: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolveSrv(name: string): Promise<Array<{ name: string; port: number }>>;
  fetchText(url: string): Promise<string | null>;
}

function settingsFor(email: string, imap: [string, number, Security], smtp: [string, number, Security]): MailboxSettings {
  return {
    imap: { host: imap[0], port: imap[1], security: imap[2], username: email },
    smtp: { host: smtp[0], port: smtp[1], security: smtp[2], username: email },
  };
}

/** Parses a Thunderbird autoconfig document (config-v1.1.xml). Plain-text servers are ignored. */
export function parseAutoconfig(xml: string, email: string): MailboxSettings | null {
  const [local = '', domain = ''] = email.split('@');
  const pick = (block: string | undefined, tag: string) => block?.match(new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`, 'i'))?.[1];
  const server = (type: 'incomingServer' | 'outgoingServer', proto: string): ServerSettings | null => {
    const re = new RegExp(`<${type}[^>]*type="${proto}"[^>]*>([\\s\\S]*?)</${type}>`, 'gi');
    for (const m of xml.matchAll(re)) {
      const block = m[1];
      const host = pick(block, 'hostname');
      const port = Number(pick(block, 'port'));
      const socket = (pick(block, 'socketType') ?? '').toUpperCase();
      const security: Security | null = socket === 'SSL' ? 'tls' : socket === 'STARTTLS' ? 'starttls' : null;
      if (!host || !port || !security) continue;
      const user = (pick(block, 'username') ?? '%EMAILADDRESS%')
        .replace('%EMAILADDRESS%', email).replace('%EMAILLOCALPART%', local).replace('%EMAILDOMAIN%', domain);
      return { host: host.replace('%EMAILDOMAIN%', domain).toLowerCase(), port, security, username: user };
    }
    return null;
  };
  const imap = server('incomingServer', 'imap');
  const smtp = server('outgoingServer', 'smtp');
  return imap && smtp ? { imap, smtp } : null;
}

export function defaultDiscoveryDeps(cfg: Config): DiscoveryDeps {
  return {
    resolveMx: (d) => resolveMx(d),
    resolveSrv: (n) => resolveSrv(n),
    async fetchText(url) {
      const u = new URL(url);
      // The autoconfig host is controlled by whoever owns the email domain: vet it like a mail server.
      if (u.hostname !== 'autoconfig.thunderbird.net') {
        try {
          await resolveMailHost(cfg, u.hostname, 993, 'imap');
        } catch {
          return null;
        }
      }
      try {
        const res = await fetch(url, { redirect: u.hostname === 'autoconfig.thunderbird.net' ? 'follow' : 'manual', signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;
        const text = await res.text();
        return text.length < 200_000 ? text : null;
      } catch {
        return null;
      }
    },
  };
}

const safe = async <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

/** Collects likely server settings for an address, most trustworthy first. Nothing is contacted with credentials here. */
export async function discover(email: string, deps: DiscoveryDeps): Promise<DiscoveryResult> {
  const domain = email.split('@')[1]!.toLowerCase();
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (c: Candidate) => {
    const key = `${c.settings.imap.host}:${c.settings.imap.port}|${c.settings.smtp.host}:${c.settings.smtp.port}`;
    if (!seen.has(key)) { seen.add(key); out.push(c); }
  };
  let hint: ProviderHint | undefined;

  const byDomain = PROVIDERS.find((p) => p.domains?.includes(domain));
  if (byDomain) {
    hint = byDomain;
    add({ source: 'provider', provider: byDomain.name, settings: settingsFor(email, byDomain.imap, byDomain.smtp) });
  }

  const [mx, autoconfig, wellKnown, ispdb, srvImap, srvSubmissions, srvSubmission] = await Promise.all([
    safe(deps.resolveMx(domain)),
    safe(deps.fetchText(`https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`)),
    safe(deps.fetchText(`https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`)),
    safe(deps.fetchText(`https://autoconfig.thunderbird.net/v1.1/${domain}`)),
    safe(deps.resolveSrv(`_imaps._tcp.${domain}`)),
    safe(deps.resolveSrv(`_submissions._tcp.${domain}`)),
    safe(deps.resolveSrv(`_submission._tcp.${domain}`)),
  ]);

  const mxHosts = (mx ?? []).sort((a, b) => a.priority - b.priority).map((m) => m.exchange.toLowerCase().replace(/\.$/, ''));
  for (const host of mxHosts) {
    const p = PROVIDERS.find((x) => x.mxSuffixes?.some((s) => host === s || host.endsWith(`.${s}`)));
    if (p) {
      hint ??= p;
      add({ source: 'mx', provider: p.name, settings: settingsFor(email, p.imap, p.smtp) });
      break;
    }
  }

  for (const [xml, source] of [[autoconfig, 'autoconfig'], [wellKnown, 'autoconfig'], [ispdb, 'ispdb']] as const) {
    const parsed = xml ? parseAutoconfig(xml, email) : null;
    if (parsed) add({ source, settings: parsed });
  }

  const srvHost = (r: Array<{ name: string; port: number }> | null) => (r && r[0] && r[0].name !== '.' ? r[0] : null);
  const si = srvHost(srvImap);
  const ss = srvHost(srvSubmissions) ?? srvHost(srvSubmission);
  if (si && ss) {
    add({ source: 'srv', settings: settingsFor(email, [si.name, si.port, 'tls'], [ss.name, ss.port, ss === srvHost(srvSubmissions) ? 'tls' : 'starttls']) });
  }

  // Common patterns on cPanel and similar hosting. The MX host is often the mail server itself.
  for (const host of [`mail.${domain}`, ...mxHosts.slice(0, 1), `imap.${domain}`, domain]) {
    const smtpHost = host === `imap.${domain}` ? `smtp.${domain}` : host;
    add({ source: 'guess', settings: settingsFor(email, [host, 993, 'tls'], [smtpHost, 465, 'tls']) });
  }
  return { candidates: out, hint };
}
