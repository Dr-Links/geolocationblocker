import type { Tx } from '../lib/db.js';
import { analyseMessage, levelOf as analyseLevel, type SecurityFlags } from './phishing.js';

/**
 * Recomputes a message's warnings from what is stored (headers, attachments, sender checks, and the text
 * when given). A "blocked sender" mark set by the blocklist is kept.
 */
export async function refreshSecurity(c: Tx, messageId: string, html: string | null): Promise<SecurityFlags> {
  const { rows } = await c.query<{ from_address: string | null; from_name: string | null; auth_results: { spf?: string; dkim?: string; dmarc?: string } | null;
                                    security_flags: Partial<SecurityFlags>; reply_to: string[] | null; risks: string[] | null; infected: number }>(
    `SELECT m.from_address, m.from_name, m.auth_results, m.security_flags,
            (SELECT array_agg(address) FROM message_addresses WHERE message_id = m.id AND kind = 'reply_to') AS reply_to,
            (SELECT array_agg(risk_level) FROM attachments WHERE message_id = m.id) AS risks,
            (SELECT count(*)::int FROM attachments WHERE message_id = m.id AND scan_status = 'infected') AS infected
       FROM messages m WHERE m.id = $1`, [messageId]);
  const r = rows[0];
  if (!r) return { level: 'none', reasons: [] };
  const flags = analyseMessage({ fromAddress: r.from_address, fromName: r.from_name, replyTo: r.reply_to ?? [], authResults: r.auth_results,
    attachmentRisks: r.risks ?? [], infectedAttachments: r.infected, html });
  // Link checks need the text; keep earlier link findings when it is not available now (e.g. evicted).
  const previous = r.security_flags?.reasons ?? [];
  const keep = previous.filter((p) => p.code === 'blocked_sender' || (!html && ['link_mismatch', 'lookalike_link', 'ip_link'].includes(p.code)));
  const reasons = [...keep, ...flags.reasons.filter((f) => !keep.some((k) => k.code === f.code && k.detail === f.detail))];
  const out: SecurityFlags = { level: analyseLevel(reasons), reasons };
  await c.query(`UPDATE messages SET security_flags = $2 WHERE id = $1`, [messageId, JSON.stringify(out)]);
  return out;
}
