import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { withUser, type Tx } from '../lib/db.js';
import { AppError, parse } from '../lib/errors.js';
import { buildMime, newMessageId, parseRecipients, replySubject, withQuote, type Recipient } from '../send/mime.js';
import { sendClaimed } from '../send/sender.js';
import type { Deps } from '../app.js';

const DEFAULT_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
export const VISIBLE_RECIPIENT_WARNING = 10;

const recipients = z.array(z.union([z.string().max(2000), z.object({ address: z.string().max(254), name: z.string().max(200).nullable().optional() })])).max(1000);
const idParam = z.object({ id: z.string().uuid() });

interface OutboundRow {
  id: string; mailbox_id: string; mailbox_email: string; status: string; subject: string | null; compose_kind: string;
  recipient_count: number; release_at: Date | null; scheduled_at: Date | null; sent_at: Date | null; attempt_count: number;
  next_attempt_at: Date | null; last_error_code: string | null; last_error_message: string | null; sent_copy_state: string;
  created_at: Date; to_summary: string | null; source_message_id: string | null;
}

const SELECT = `SELECT o.*, mb.email_address AS mailbox_email,
       (SELECT string_agg(coalesce(r.name, r.address), ', ' ORDER BY r.kind, r.position) FROM outbound_recipients r WHERE r.outbound_id = o.id AND r.kind = 'to') AS to_summary
  FROM outbound_messages o JOIN mailboxes mb ON mb.id = o.mailbox_id`;

const iso = (d: Date | null) => d?.toISOString() ?? null;
export const outboundDto = (o: OutboundRow) => ({
  id: o.id,
  mailbox: { id: o.mailbox_id, email: o.mailbox_email },
  status: o.status,
  kind: o.compose_kind,
  subject: o.subject,
  toSummary: o.to_summary,
  recipientCount: o.recipient_count,
  releaseAt: iso(o.release_at),
  scheduledAt: iso(o.scheduled_at),
  sentAt: iso(o.sent_at),
  attemptCount: o.attempt_count,
  nextAttemptAt: iso(o.next_attempt_at),
  lastErrorCode: o.last_error_code,
  lastErrorMessage: o.last_error_message,
  sentCopy: o.sent_copy_state,
  canUndo: o.status === 'pending_undo' && !!o.release_at && o.release_at.getTime() > Date.now(),
  createdAt: o.created_at.toISOString(),
});

async function loadOutbound(c: Tx, id: string) {
  const { rows } = await c.query<OutboundRow>(`${SELECT} WHERE o.id = $1`, [id]);
  return rows[0] ?? null;
}

interface SourceRow {
  id: string; mailbox_id: string; subject: string | null; from_address: string | null; from_name: string | null; received_at: Date;
  sent_at: Date | null; message_id_header: string | null; references_ids: string[]; text_body: string | null; html_sanitized: string | null;
}

async function loadSource(c: Tx, id: string) {
  const { rows } = await c.query<SourceRow>(
    `SELECT m.id, m.mailbox_id, m.subject, m.from_address, m.from_name, m.received_at, m.sent_at, m.message_id_header, m.references_ids,
            b.text_body, b.html_sanitized
       FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id WHERE m.id = $1`, [id]);
  const src = rows[0];
  if (!src) return null;
  const { rows: addrs } = await c.query<{ kind: string; address: string; name: string | null }>(
    `SELECT kind, address, name FROM message_addresses WHERE message_id = $1 ORDER BY kind, position`, [id]);
  return { src, addrs };
}

const fmt = (a: { address: string; name: string | null }) => (a.name ? `${a.name} <${a.address}>` : a.address);

export function registerOutboundRoutes(app: FastifyInstance, deps: Deps) {
  const { cfg, db } = deps;
  const active = { preHandler: [app.authenticate, app.requireActive] };
  const uidOf = (req: { auth?: { user: { id: string } } }) => req.auth!.user.id;

  /** Suggested sender, recipients and subject for a reply, reply-all or forward. */
  app.get('/v1/messages/:id/compose', active, async (req) => {
    const { id } = parse(idParam, req.params);
    const { mode } = parse(z.object({ mode: z.enum(['reply', 'reply_all', 'forward']) }), req.query);
    return withUser(db.api, uidOf(req), async (c) => {
      const loaded = await loadSource(c, id);
      if (!loaded) throw new AppError(404, 'not_found', 'Message not found.');
      const { src, addrs } = loaded;
      const own = new Set((await c.query<{ email_address: string }>(`SELECT email_address FROM mailboxes`)).rows.map((r) => r.email_address));
      const pick = (kind: string) => addrs.filter((a) => a.kind === kind);
      const replyTo = pick('reply_to').length ? pick('reply_to') : pick('from');
      let to: Recipient[] = [];
      let cc: Recipient[] = [];
      if (mode !== 'forward') {
        to = replyTo.filter((a) => !own.has(a.address));
        // Replying to your own sent message: reply to its recipients instead.
        if (!to.length) to = pick('to').filter((a) => !own.has(a.address));
        if (mode === 'reply_all') {
          const seen = new Set(to.map((a) => a.address));
          cc = [...pick('to'), ...pick('cc')].filter((a) => !own.has(a.address) && !seen.has(a.address) && (seen.add(a.address), true));
        }
      }
      return {
        mailboxId: src.mailbox_id,
        mode,
        to: to.map((a) => ({ address: a.address, name: a.name })),
        cc: cc.map((a) => ({ address: a.address, name: a.name })),
        subject: replySubject(src.subject, mode),
        quoteAttribution: mode === 'forward' ? 'Forwarded message' : `On ${(src.sent_at ?? src.received_at).toUTCString()}, ${src.from_name || src.from_address || 'the sender'} wrote:`,
      };
    });
  });

  app.post('/v1/outbound', { ...active, config: { rateLimit: { max: 120, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const body = parse(z.object({
      mailboxId: z.string().uuid(),
      mode: z.enum(['new', 'reply', 'reply_all', 'forward']).default('new'),
      sourceMessageId: z.string().uuid().optional(),
      to: recipients.default([]),
      cc: recipients.default([]),
      bcc: recipients.default([]),
      subject: z.string().max(998).default(''),
      text: z.string().max(2_000_000).default(''),
      html: z.string().max(5_000_000).nullable().optional(),
      includeQuote: z.boolean().default(true),
      idempotencyKey: z.string().uuid(),
      confirmVisibleRecipients: z.boolean().optional(),
      allowDifferentSender: z.boolean().optional(),
    }), req.body);
    const uid = uidOf(req);

    const result = await withUser(db.api, uid, async (c) => {
      const existing = await c.query<{ id: string }>(`SELECT id FROM outbound_messages WHERE idempotency_key = $1`, [body.idempotencyKey]);
      if (existing.rows[0]) return { id: existing.rows[0].id, created: false };

      const { rows: mbx } = await c.query<{ id: string; email_address: string; display_name: string | null; status: string;
                                            max_recipients_per_msg: number | null; max_message_bytes: number | null }>(
        `SELECT id, email_address, display_name, status, max_recipients_per_msg, max_message_bytes FROM mailboxes WHERE id = $1`, [body.mailboxId]);
      const m = mbx[0];
      if (!m) throw new AppError(404, 'not_found', 'Sending mailbox not found.');
      if (m.status === 'disconnected') throw new AppError(409, 'conflict', 'This mailbox is disconnected. Reconnect it to send.');
      if (m.status === 'auth_failed') throw new AppError(409, 'conflict', `The mail server no longer accepts the password of ${m.email_address}. Update it before sending.`);

      const to = parseRecipients(body.to), cc = parseRecipients(body.cc), bcc = parseRecipients(body.bcc);
      const invalid = [...to.invalid, ...cc.invalid, ...bcc.invalid];
      if (invalid.length) throw new AppError(400, 'validation_failed', `These addresses are not valid: ${invalid.slice(0, 5).join(', ')}`, { invalid });
      // An address listed in several fields is sent once, in the most visible field only.
      const seen = new Set<string>();
      const dedupe = (list: Recipient[]) => list.filter((r) => !seen.has(r.address) && (seen.add(r.address), true));
      const finalTo = dedupe(to.valid), finalCc = dedupe(cc.valid), finalBcc = dedupe(bcc.valid);
      const total = finalTo.length + finalCc.length + finalBcc.length;
      if (!total) throw new AppError(400, 'validation_failed', 'Add at least one recipient.');
      const maxRcpt = m.max_recipients_per_msg ?? 100;
      if (total > maxRcpt) {
        throw new AppError(400, 'validation_failed', `This mailbox can send to at most ${maxRcpt} recipients per message. Split the list into smaller groups.`, { maxRecipients: maxRcpt });
      }
      const visible = finalTo.length + finalCc.length;
      if (visible > VISIBLE_RECIPIENT_WARNING && !body.confirmVisibleRecipients) {
        throw new AppError(409, 'conflict', `All ${visible} people in To and Cc will see each other's addresses. Put them in Bcc to keep them private, or confirm to send as is.`,
          { requires: 'confirmVisibleRecipients', visibleRecipients: visible });
      }

      let text = body.text;
      let html = body.html ?? null;
      let inReplyTo: string | null = null;
      let references: string[] = [];
      if (body.mode !== 'new') {
        if (!body.sourceMessageId) throw new AppError(400, 'validation_failed', 'Replies and forwards need the original message.');
        const loaded = await loadSource(c, body.sourceMessageId);
        if (!loaded) throw new AppError(404, 'not_found', 'Original message not found.');
        const { src, addrs } = loaded;
        if (src.mailbox_id !== m.id && !body.allowDifferentSender) {
          throw new AppError(409, 'conflict', 'You are replying from a different mailbox than the one that received this message. Confirm to continue.',
            { requires: 'allowDifferentSender' });
        }
        if (body.mode !== 'forward' && src.message_id_header) {
          inReplyTo = src.message_id_header;
          references = [...src.references_ids, src.message_id_header].slice(-20);
        }
        if (body.includeQuote) {
          const q = withQuote(body.mode, text, html, {
            from: src.from_address ? fmt({ address: src.from_address, name: src.from_name }) : 'unknown sender',
            date: src.sent_at ?? src.received_at,
            subject: src.subject,
            to: addrs.filter((a) => a.kind === 'to').map(fmt).join(', '),
            text: src.text_body,
            html: src.html_sanitized,
          });
          text = q.text;
          html = q.html;
        }
      }

      const messageId = newMessageId(m.email_address);
      const mime = await buildMime({
        from: { address: m.email_address, name: m.display_name }, to: finalTo, cc: finalCc, bcc: finalBcc,
        subject: body.subject, text, html, messageId, inReplyTo, references,
      });
      const maxBytes = m.max_message_bytes ?? DEFAULT_MAX_MESSAGE_BYTES;
      if (mime.length > maxBytes) {
        throw new AppError(400, 'validation_failed', `The message is ${(mime.length / 1048576).toFixed(1)} MB; this mailbox accepts at most ${(maxBytes / 1048576).toFixed(0)} MB.`);
      }
      const { rows: s } = await c.query<{ undo_send_seconds: number }>(`SELECT undo_send_seconds FROM platform_settings`);
      const undo = s[0]?.undo_send_seconds ?? 10;
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO outbound_messages (user_id, mailbox_id, idempotency_key, message_id_header, compose_kind, source_message_id, subject,
                recipient_count, status, release_at, mime_bytes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_undo', now() + make_interval(secs => $9), $10)
         ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`,
        [uid, m.id, body.idempotencyKey, messageId, body.mode, body.sourceMessageId ?? null, body.subject, total, undo, mime.length]);
      if (!rows[0]) {
        const again = await c.query<{ id: string }>(`SELECT id FROM outbound_messages WHERE idempotency_key = $1`, [body.idempotencyKey]);
        return { id: again.rows[0]!.id, created: false };
      }
      const id = rows[0].id;
      await c.query(`INSERT INTO outbound_mime (outbound_id, user_id, mime) VALUES ($1, $2, $3)`, [id, uid, mime]);
      for (const [kind, list] of [['to', finalTo], ['cc', finalCc], ['bcc', finalBcc]] as const) {
        for (const [i, r] of list.entries()) {
          await c.query(`INSERT INTO outbound_recipients (outbound_id, user_id, kind, position, address, name) VALUES ($1,$2,$3,$4,$5,$6)`,
            [id, uid, kind, i, r.address, r.name ?? null]);
        }
      }
      await audit(c, { actorType: 'user', actorUserId: uid, action: 'outbound.queued', targetType: 'outbound', targetId: id, targetUserId: uid, ip: req.ip,
        details: { mailbox_id: m.id, recipients: total, kind: body.mode } });
      return { id, created: true, undo };
    });

    if (result.created && deps.inProcessSend !== false) scheduleInProcessSend(deps, uid, result.id, (result.undo ?? 10) * 1000 + 300, app.log.warn.bind(app.log));
    const o = await withUser(db.api, uid, (c) => loadOutbound(c, result.id));
    return reply.code(result.created ? 201 : 200).send({ outbound: outboundDto(o!) });
  });

  app.post('/v1/outbound/:id/undo', active, async (req) => {
    const { id } = parse(idParam, req.params);
    const uid = uidOf(req);
    return withUser(db.api, uid, async (c) => {
      const r = await c.query(`UPDATE outbound_messages SET status = 'cancelled' WHERE id = $1 AND status = 'pending_undo'`, [id]);
      const o = await loadOutbound(c, id);
      if (!o) throw new AppError(404, 'not_found', 'Message not found.');
      if (!r.rowCount) {
        throw new AppError(409, 'conflict', o.status === 'sent' ? 'Too late: the mail server has already accepted this message. It cannot be recalled.'
          : `Too late to undo: the message is ${o.status}.`, { outbound: outboundDto(o) });
      }
      await audit(c, { actorType: 'user', actorUserId: uid, action: 'outbound.undone', targetType: 'outbound', targetId: id, targetUserId: uid, ip: req.ip });
      return { outbound: outboundDto(o) };
    });
  });

  app.post('/v1/outbound/:id/retry', active, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ confirmPossibleDuplicate: z.boolean().optional() }), req.body);
    const uid = uidOf(req);
    const o = await withUser(db.api, uid, async (c) => {
      const cur = await loadOutbound(c, id);
      if (!cur) throw new AppError(404, 'not_found', 'Message not found.');
      if (!['failed', 'uncertain', 'paused_suspended'].includes(cur.status)) throw new AppError(409, 'conflict', `This message is ${cur.status} and cannot be retried.`);
      if (cur.status === 'uncertain' && !body.confirmPossibleDuplicate) {
        throw new AppError(409, 'conflict', 'This message may already have been delivered. Sending again could deliver it twice. Confirm to send anyway.',
          { requires: 'confirmPossibleDuplicate' });
      }
      await c.query(`UPDATE outbound_messages SET status = 'queued', next_attempt_at = now(), attempt_count = 0, paused_from_status = NULL WHERE id = $1`, [id]);
      await audit(c, { actorType: 'user', actorUserId: uid, action: 'outbound.retried', targetType: 'outbound', targetId: id, targetUserId: uid, ip: req.ip, details: { from: cur.status } });
      return loadOutbound(c, id);
    });
    if (deps.inProcessSend !== false) scheduleInProcessSend(deps, uid, id, 100, app.log.warn.bind(app.log));
    return { outbound: outboundDto(o!) };
  });

  app.post('/v1/outbound/:id/discard', active, async (req) => {
    const { id } = parse(idParam, req.params);
    const uid = uidOf(req);
    return withUser(db.api, uid, async (c) => {
      const r = await c.query(`UPDATE outbound_messages SET status = 'cancelled', lease_until = NULL
                                WHERE id = $1 AND status IN ('failed','uncertain','paused_suspended','queued','scheduled','pending_undo')`, [id]);
      const o = await loadOutbound(c, id);
      if (!o) throw new AppError(404, 'not_found', 'Message not found.');
      if (!r.rowCount) throw new AppError(409, 'conflict', `This message is ${o.status} and cannot be discarded.`);
      return { outbound: outboundDto(o) };
    });
  });

  app.get('/v1/outbound', active, async (req) => {
    const q = parse(z.object({ filter: z.enum(['outbox', 'problems', 'all']).default('outbox') }), req.query);
    const where = q.filter === 'outbox' ? `o.status IN ('pending_undo','scheduled','queued','sending','failed','uncertain','paused_suspended')`
      : q.filter === 'problems' ? `o.status IN ('failed','uncertain','paused_suspended')` : 'true';
    const { rows } = await withUser(db.api, uidOf(req), (c) => c.query<OutboundRow>(`${SELECT} WHERE ${where} ORDER BY o.created_at DESC LIMIT 200`));
    return { outbound: rows.map(outboundDto) };
  });

  app.get('/v1/outbound/:id', active, async (req) => {
    const { id } = parse(idParam, req.params);
    return withUser(db.api, uidOf(req), async (c) => {
      const o = await loadOutbound(c, id);
      if (!o) throw new AppError(404, 'not_found', 'Message not found.');
      const { rows: attempts } = await c.query<{ attempt_no: number; started_at: Date; outcome: string | null; smtp_code: number | null; response_text: string | null }>(
        `SELECT attempt_no, started_at, outcome, smtp_code, response_text FROM delivery_attempts WHERE outbound_id = $1 ORDER BY attempt_no`, [id]);
      const { rows: rcpt } = await c.query<{ kind: string; address: string; name: string | null }>(
        `SELECT kind, address, name FROM outbound_recipients WHERE outbound_id = $1 ORDER BY kind, position`, [id]);
      return {
        outbound: outboundDto(o),
        recipients: rcpt,
        attempts: attempts.map((a) => ({ attemptNo: a.attempt_no, at: a.started_at.toISOString(), outcome: a.outcome, smtpCode: a.smtp_code, response: a.response_text })),
      };
    });
  });
}

/**
 * After the undo window, try to send right away from the API process. If the process is stopped
 * (e.g. idle shutdown on shared hosting), the cron job sends it instead; the database claim ensures
 * that only one of them ever does.
 */
export function scheduleInProcessSend(deps: Deps, userId: string, id: string, delayMs: number, log: (m: string) => void) {
  const t = setTimeout(async () => {
    try {
      const claimed = await withUser(deps.db.api, userId, (c) => c.query<{ ok: boolean }>(`SELECT app.claim_outbound_one($1, 180) AS ok`, [id]));
      if (claimed.rows[0]?.ok) await sendClaimed(deps.cfg, deps.db.api, userId, id, log);
    } catch (err) {
      log(`in-process send of ${id} failed: ${(err as Error).message}`);
    }
  }, delayMs);
  t.unref();
}
