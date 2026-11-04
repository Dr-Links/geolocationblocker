import { isIP } from 'node:net';
import { domainToUnicode } from 'node:url';

export type SecurityLevel = 'none' | 'caution' | 'danger';
export interface SecurityReason { code: string; detail?: string }
export interface SecurityFlags { level: SecurityLevel; reasons: SecurityReason[] }

/** Brands that phishing most often imitates. Their own domains (and subdomains) are never flagged. */
const BRAND_DOMAINS = [
  'paypal.com', 'google.com', 'gmail.com', 'microsoft.com', 'outlook.com', 'office.com', 'live.com', 'apple.com', 'icloud.com',
  'amazon.com', 'facebook.com', 'instagram.com', 'whatsapp.com', 'netflix.com', 'linkedin.com', 'dhl.com', 'fedex.com', 'ups.com',
  'dropbox.com', 'docusign.com', 'adobe.com', 'yahoo.com', 'binance.com', 'coinbase.com', 'hostinger.com', 'cpanel.net', 'allwebmails.com',
];
const TWO_LEVEL_SUFFIXES = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'ne', 'or', 'go']);

/** The part of a host name that the owner registered: mail.example.co.uk -> example.co.uk. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const sld = labels[labels.length - 2]!;
  const tld = labels[labels.length - 1]!;
  const take = tld.length === 2 && TWO_LEVEL_SUFFIXES.has(sld) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** Folds characters that look alike, so "paypa1", "rnicrosoft" and "g00gle" compare equal to the real names. */
function skeleton(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[аạą]/g, 'a').replace(/[её]/g, 'e').replace(/[оο]/g, 'o').replace(/[рρ]/g, 'p').replace(/[с]/g, 'c').replace(/[і]/g, 'i')
    .replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/0/g, 'o').replace(/[1|]/g, 'l').replace(/3/g, 'e').replace(/5/g, 's').replace(/\$/g, 's')
    .replace(/[il]/g, 'l').replace(/-/g, '');
}

function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** The brand a domain imitates, or null. A brand's own domain and its subdomains are not lookalikes. */
export function lookalikeOf(host: string): string | null {
  const unicode = domainToUnicode(host.toLowerCase()) || host.toLowerCase();
  const reg = registrableDomain(unicode);
  for (const brand of BRAND_DOMAINS) {
    if (reg === brand) return null;
  }
  const label = reg.split('.')[0] ?? '';
  const sk = skeleton(label);
  for (const brand of BRAND_DOMAINS) {
    const b = brand.split('.')[0]!;
    if (b.length < 4) continue;
    const bs = skeleton(b);
    if (sk === bs) return brand;                                   // paypa1.com, g00gle.net, pаypal.com (Cyrillic)
    if (b.length >= 6 && editDistance(sk, bs, 1) <= 1) return brand; // paypall.com, microsofl.com
    // The brand name inside a longer name: paypal-secure-login.com, appleid-verify.net
    if (b.length >= 5 && label.length > b.length && skeleton(label).includes(bs) && /[-.]|secure|login|verify|account|support|update|id/.test(label)) return brand;
  }
  return null;
}

const hostOf = (u: string): string | null => {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname.replace(/^\[|\]$/g, '') : null;
  } catch {
    return null;
  }
};
const decodeEntities = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

/** Links whose visible text names a different site than where they lead. */
export function linkProblems(html: string): SecurityReason[] {
  const out: SecurityReason[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (let m = re.exec(html); m && out.length < 10; m = re.exec(html)) {
    const href = decodeEntities(m[1]!);
    const target = hostOf(href);
    if (!target) continue;
    const text = decodeEntities(m[2]!.replace(/<[^>]+>/g, ' ')).trim();
    if (isIP(target) && !seen.has(`ip:${target}`)) {
      seen.add(`ip:${target}`);
      out.push({ code: 'ip_link', detail: target });
    }
    const shown = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.exec(text.replace(/\s+/g, ''));
    if (shown) {
      const shownHost = hostOf(/^https?:/i.test(shown[0]) ? shown[0] : `https://${shown[0]}`);
      if (shownHost && registrableDomain(shownHost) !== registrableDomain(target) && !seen.has(`mm:${target}`)) {
        seen.add(`mm:${target}`);
        out.push({ code: 'link_mismatch', detail: `${registrableDomain(shownHost)} → ${registrableDomain(target)}` });
      }
    }
    const like = lookalikeOf(target);
    if (like && !seen.has(`la:${target}`)) {
      seen.add(`la:${target}`);
      out.push({ code: 'lookalike_link', detail: `${registrableDomain(target)} (looks like ${like})` });
    }
  }
  return out;
}

const DANGER = new Set(['display_name_spoof', 'lookalike_sender', 'link_mismatch', 'lookalike_link', 'dmarc_fail', 'dangerous_attachment', 'malware', 'blocked_sender']);

export const levelOf = (reasons: SecurityReason[]): SecurityLevel =>
  reasons.some((r) => DANGER.has(r.code)) ? 'danger' : reasons.length ? 'caution' : 'none';

export interface AnalyseInput {
  fromAddress: string | null;
  fromName: string | null;
  replyTo: string[];
  authResults: { spf?: string; dkim?: string; dmarc?: string } | null;
  attachmentRisks: string[];
  infectedAttachments?: number;
  html: string | null;
}

/** Heuristic warnings only: they never hide or move mail; the user decides. */
export function analyseMessage(i: AnalyseInput): SecurityFlags {
  const reasons: SecurityReason[] = [];
  const fromDomain = i.fromAddress?.split('@')[1]?.toLowerCase() ?? null;
  if (i.authResults?.dmarc === 'fail') reasons.push({ code: 'dmarc_fail' });
  else if (i.authResults?.spf === 'fail' && i.authResults.dkim !== 'pass') reasons.push({ code: 'spf_fail' });
  if (i.fromName && fromDomain) {
    const inName = /[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/i.exec(i.fromName);
    if (inName && registrableDomain(inName[1]!) !== registrableDomain(fromDomain)) {
      reasons.push({ code: 'display_name_spoof', detail: `${inName[0]} / ${i.fromAddress}` });
    }
  }
  if (fromDomain) {
    const like = lookalikeOf(fromDomain);
    if (like) reasons.push({ code: 'lookalike_sender', detail: `${fromDomain} (looks like ${like})` });
    else if (fromDomain.split('.').some((l) => l.startsWith('xn--'))) reasons.push({ code: 'unusual_characters', detail: domainToUnicode(fromDomain) });
    const other = i.replyTo.map((r) => r.split('@')[1]?.toLowerCase()).find((d) => d && registrableDomain(d) !== registrableDomain(fromDomain));
    if (other) reasons.push({ code: 'reply_to_differs', detail: other });
  }
  if (i.attachmentRisks.includes('dangerous')) reasons.push({ code: 'dangerous_attachment' });
  if (i.infectedAttachments) reasons.push({ code: 'malware' });
  if (i.html) reasons.push(...linkProblems(i.html));
  return { level: levelOf(reasons), reasons };
}
