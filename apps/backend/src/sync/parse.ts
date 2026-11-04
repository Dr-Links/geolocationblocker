import sanitizeHtml from 'sanitize-html';

// ---------------------------------------------------------------------------
// HTML: email HTML is hostile input. Allow-list sanitising on the server, then the app renders it
// in a WebView with JavaScript disabled. Remote images are blocked at display time by default.
// ---------------------------------------------------------------------------

const SAFE_STYLE = /^(?!.*(url\s*\(|expression\s*\(|javascript:|behavior\s*:|-moz-binding)).*$/i;
const STYLE_PROPS = [
  'color', 'background-color', 'background', 'text-align', 'vertical-align', 'font', 'font-size', 'font-weight', 'font-style',
  'font-family', 'text-decoration', 'text-transform', 'line-height', 'letter-spacing', 'white-space', 'width', 'max-width',
  'min-width', 'height', 'max-height', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border', 'border-top', 'border-right', 'border-bottom',
  'border-left', 'border-color', 'border-width', 'border-style', 'border-radius', 'border-collapse', 'border-spacing',
  'display', 'float', 'clear', 'list-style', 'list-style-type', 'table-layout', 'direction',
];

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'a', 'abbr', 'b', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'div',
    'dl', 'dt', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p',
    'pre', 'q', 's', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
    'tr', 'tt', 'u', 'ul',
  ],
  allowedAttributes: {
    '*': ['style', 'align', 'valign', 'dir', 'title', 'width', 'height', 'bgcolor', 'lang'],
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'border'],
    font: ['color', 'face', 'size'],
    table: ['border', 'cellpadding', 'cellspacing'],
    td: ['colspan', 'rowspan', 'nowrap'],
    th: ['colspan', 'rowspan', 'nowrap'],
    col: ['span'],
    ol: ['start', 'type'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'cid', 'data'] },
  allowProtocolRelative: false,
  allowedStyles: { '*': Object.fromEntries(STYLE_PROPS.map((p) => [p, [SAFE_STYLE]])) },
  disallowedTagsMode: 'discard',
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'title', 'head'],
  transformTags: {
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' } }),
  },
};

export function sanitizeEmailHtml(html: string): { html: string; hasRemoteContent: boolean } {
  const clean = sanitizeHtml(html, OPTIONS);
  return { html: clean, hasRemoteContent: /<img\b[^>]*\ssrc="https?:/i.test(clean) };
}

/** Display-time: hide remote images (tracking pixels, IP leaks) unless the user allowed them. */
export function blockRemoteImages(html: string): string {
  return html.replace(/(<img\b[^>]*?)\ssrc="(https?:[^"]*)"/gi, '$1 src="" data-blocked-src="$2"');
}

export function htmlToText(html: string): string {
  return sanitizeHtml(html.replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li)\b[^>]*>/gi, '\n$&'), { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

export function snippetOf(text: string | null | undefined): string | null {
  if (!text) return null;
  const s = text.replace(/^>.*$/gm, '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 200) : null;
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

export function normalizeSubject(subject: string | null | undefined): string {
  let s = (subject ?? '').trim();
  for (;;) {
    const next = s.replace(/^(re|fw|fwd|aw|wg|sv|vs|antw|rif|tr)(\[\d+\])?\s*:\s*/i, '').replace(/^\[[^\]]{1,40}\]\s*/, '').trim();
    if (next === s) return s.toLowerCase();
    s = next;
  }
}

/** Parses the few raw headers we fetch (References, priority, Authentication-Results). */
export function parseHeaderBlock(raw: Buffer | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  const unfolded = raw.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) {
      const k = line.slice(0, i).trim().toLowerCase();
      out[k] = out[k] ? `${out[k]} ${line.slice(i + 1).trim()}` : line.slice(i + 1).trim();
    }
  }
  return out;
}

export function messageIds(value: string | undefined): string[] {
  return [...(value ?? '').matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]!).slice(-50);
}

export function stripAngle(id: string | undefined | null): string | null {
  if (!id) return null;
  const m = id.match(/<([^<>\s]+)>/);
  return (m ? m[1]! : id.trim()) || null;
}

export function priorityOf(h: Record<string, string>): 'high' | 'normal' | 'low' {
  const xp = h['x-priority'] ?? '';
  const imp = (h.importance ?? h.priority ?? '').toLowerCase();
  if (/^\s*[12]\b/.test(xp) || imp.includes('high') || imp.includes('urgent')) return 'high';
  if (/^\s*[45]\b/.test(xp) || imp.includes('low') || imp.includes('non-urgent')) return 'low';
  return 'normal';
}

/** Summarises SPF/DKIM/DMARC verdicts added by the receiving server. */
export function authResultsOf(h: Record<string, string>): { spf?: string; dkim?: string; dmarc?: string } | null {
  const ar = h['authentication-results'];
  if (!ar) return null;
  const pick = (k: string) => ar.match(new RegExp(`\\b${k}=(\\w+)`, 'i'))?.[1]?.toLowerCase();
  const r = { spf: pick('spf'), dkim: pick('dkim'), dmarc: pick('dmarc') };
  return r.spf || r.dkim || r.dmarc ? r : null;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

export interface StructureNode {
  part?: string;
  type: string;
  parameters?: Record<string, string>;
  id?: string;
  size?: number;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  childNodes?: StructureNode[];
}

export interface AttachmentMeta {
  partId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentId: string | null;
  isInline: boolean;
  risk: 'low' | 'elevated' | 'dangerous';
}

const DANGEROUS = /\.(exe|scr|com|bat|cmd|pif|cpl|msi|msp|jar|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|hta|lnk|reg|apk|app|dmg|iso|img|vhd|scf|application|gadget|chm)$/i;
const ELEVATED = /\.(docm|xlsm|pptm|dotm|xltm|zip|rar|7z|html?|svg|xlam|ppam|one)$/i;

export function attachmentRisk(filename: string): 'low' | 'elevated' | 'dangerous' {
  const name = filename.toLowerCase().trim();
  if (DANGEROUS.test(name) || /\.(pdf|docx?|xlsx?|jpe?g|png|txt)\s*\.[a-z0-9]{2,4}$/.test(name)) return 'dangerous';
  if (ELEVATED.test(name)) return 'elevated';
  return 'low';
}

/** Walks the MIME tree: returns attachments and the part ids of the main text and HTML bodies. */
export function analyseStructure(root: StructureNode | undefined) {
  const attachments: AttachmentMeta[] = [];
  let textPart: string | null = null;
  let htmlPart: string | null = null;
  const walk = (n: StructureNode) => {
    const type = n.type.toLowerCase();
    if (type.startsWith('multipart/')) return n.childNodes?.forEach(walk);
    // A forwarded message (message/rfc822) is listed as an attachment, so its parts are never mistaken for this body.
    const filename = n.dispositionParameters?.filename ?? n.parameters?.name ?? null;
    const disposition = n.disposition?.toLowerCase();
    const isBodyText = (type === 'text/plain' || type === 'text/html') && disposition !== 'attachment' && !filename;
    if (isBodyText) {
      if (type === 'text/plain' && !textPart) textPart = n.part ?? '1';
      if (type === 'text/html' && !htmlPart) htmlPart = n.part ?? '1';
      return;
    }
    const name = filename ?? (type === 'message/rfc822' ? 'forwarded-message.eml' : `attachment.${type.split('/')[1] ?? 'bin'}`);
    attachments.push({
      partId: n.part ?? '1',
      filename: name.slice(0, 255),
      mimeType: type.slice(0, 127),
      sizeBytes: n.size ?? 0,
      contentId: stripAngle(n.id),
      isInline: disposition === 'inline' || (!!n.id && type.startsWith('image/') && disposition !== 'attachment'),
      risk: attachmentRisk(name),
    });
  };
  if (root) walk(root);
  return { attachments, textPart, htmlPart };
}

export function decodeFlags(flags: Set<string> | undefined) {
  const f = flags ?? new Set<string>();
  return {
    is_seen: f.has('\\Seen'),
    is_flagged: f.has('\\Flagged'),
    is_answered: f.has('\\Answered'),
    is_draft: f.has('\\Draft'),
    is_forwarded: f.has('$Forwarded'),
    keywords: [...f].filter((x) => !x.startsWith('\\') && x !== '$Forwarded').slice(0, 30),
  };
}
