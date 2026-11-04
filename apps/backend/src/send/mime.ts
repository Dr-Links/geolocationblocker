import { randomUUID } from 'node:crypto';
import addressparser from 'nodemailer/lib/addressparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import { htmlToText, sanitizeEmailHtml } from '../sync/parse.js';

export interface Recipient {
  address: string;
  name?: string | null;
}

const ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** Parses "Name <a@b.c>, d@e.f" style input as well as plain arrays. Returns valid and invalid entries. */
export function parseRecipients(input: Array<string | Recipient>): { valid: Recipient[]; invalid: string[] } {
  const valid: Recipient[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const parsed = typeof item === 'string' ? addressparser(item, { flatten: true }) : [{ address: item.address, name: item.name ?? '' }];
    for (const p of parsed) {
      const address = (p.address ?? '').trim().toLowerCase();
      if (!address || !ADDRESS.test(address) || address.length > 254 || /[\r\n]/.test(p.name ?? '')) {
        invalid.push(typeof item === 'string' ? item : item.address);
        continue;
      }
      if (seen.has(address)) continue;
      seen.add(address);
      valid.push({ address, name: p.name?.trim().slice(0, 200) || null });
    }
  }
  return { valid, invalid };
}

export function newMessageId(fromAddress: string): string {
  const domain = fromAddress.split('@')[1] ?? 'localhost';
  return `${randomUUID()}@${domain}`;
}

export interface ComposeInput {
  from: Recipient;
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  subject: string;
  text: string;
  html?: string | null;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  date?: Date;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string; cid?: string }>;
}

/**
 * Builds the exact message bytes once, before the first send attempt. Bcc recipients are not written
 * into the headers (they are only in the SMTP envelope). HTML is sanitised and always paired with plain text.
 */
export async function buildMime(m: ComposeInput): Promise<Buffer> {
  const html = m.html ? sanitizeEmailHtml(m.html).html : undefined;
  const composer = new MailComposer({
    from: m.from.name ? { name: m.from.name, address: m.from.address } : m.from.address,
    to: m.to.map((r) => (r.name ? { name: r.name, address: r.address } : r.address)),
    cc: m.cc.map((r) => (r.name ? { name: r.name, address: r.address } : r.address)),
    subject: m.subject,
    text: m.text || (html ? htmlToText(html) : ''),
    html,
    messageId: `<${m.messageId}>`,
    inReplyTo: m.inReplyTo ? `<${m.inReplyTo}>` : undefined,
    references: m.references?.length ? m.references.map((r) => `<${r}>`).join(' ') : undefined,
    date: m.date ?? new Date(),
    headers: { 'X-Mailer': 'Email Platform' },
    attachments: m.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType, ...(a.cid ? { cid: a.cid, contentDisposition: 'inline' as const } : {}) })),
  });
  return composer.compile().build();
}

export function replySubject(subject: string | null, kind: 'reply' | 'reply_all' | 'forward'): string {
  const s = (subject ?? '').trim();
  if (kind === 'forward') return /^(fwd?|fw):/i.test(s) ? s : `Fwd: ${s}`;
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

const quoteLines = (text: string) => text.split(/\r?\n/).map((l) => `> ${l}`).join('\n');
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface SourceForQuote {
  from: string;
  date: Date;
  subject: string | null;
  to: string;
  text: string | null;
  html: string | null;
}

/** Adds the quoted original under a reply, or the original under a forward. */
export function withQuote(kind: 'reply' | 'reply_all' | 'forward', text: string, html: string | null | undefined, src: SourceForQuote) {
  const when = src.date.toUTCString();
  const original = src.text ?? (src.html ? htmlToText(src.html) : '');
  if (kind === 'forward') {
    const header = `---------- Forwarded message ----------\nFrom: ${src.from}\nDate: ${when}\nSubject: ${src.subject ?? ''}\nTo: ${src.to}\n`;
    return {
      text: `${text}\n\n${header}\n${original}`,
      html: html != null || src.html
        ? `${html ?? escapeHtml(text).replace(/\n/g, '<br>')}<br><br><div>---------- Forwarded message ----------<br>From: ${escapeHtml(src.from)}<br>Date: ${escapeHtml(when)}<br>Subject: ${escapeHtml(src.subject ?? '')}<br>To: ${escapeHtml(src.to)}<br><br>${src.html ?? escapeHtml(original).replace(/\n/g, '<br>')}</div>`
        : null,
    };
  }
  const intro = `On ${when}, ${src.from} wrote:`;
  return {
    text: `${text}\n\n${intro}\n${quoteLines(original)}`,
    html: html != null || src.html
      ? `${html ?? escapeHtml(text).replace(/\n/g, '<br>')}<br><br><div>${escapeHtml(intro)}</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${src.html ?? escapeHtml(original).replace(/\n/g, '<br>')}</blockquote>`
      : null,
  };
}

/** Adds the signature once, before any quoted text. */
export function withSignature(text: string, html: string | null | undefined, sig: { text_body: string; html_body: string | null } | null) {
  if (!sig) return { text, html: html ?? null };
  const sigText = sig.text_body.trim();
  return {
    text: sigText ? `${text}\n\n-- \n${sigText}` : text,
    html: html != null
      ? `${html}<br><br><div class="signature">-- <br>${sig.html_body ?? escapeHtml(sigText).replace(/\n/g, '<br>')}</div>`
      : null,
  };
}

/** Images placed in the editor carry data-upload-id; they become cid: references to inline attachments. */
export function extractInlineImages(html: string): { html: string; uploadIds: string[] } {
  const ids: string[] = [];
  const out = html.replace(/<img\b[^>]*\bdata-upload-id="([0-9a-f-]{36})"[^>]*>/gi, (_m, id: string) => {
    ids.push(id);
    return `<img src="cid:${id}@inline" alt="">`;
  });
  return { html: out, uploadIds: [...new Set(ids)] };
}
