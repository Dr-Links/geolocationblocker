import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUser, type Tx } from '../lib/db.js';
import { AppError, parse } from '../lib/errors.js';
import { sanitizeEmailHtml } from '../sync/parse.js';
import { storageStatus } from '../storage/quota.js';
import { enforceScan, scanBytes } from '../security/clamav.js';
import { putBlob } from '../storage/blobs.js';
import { detectType, uploadRisk } from '../storage/sniff.js';
import type { Deps } from '../app.js';

/** Largest single upload accepted by this server. Providers usually cap whole messages at 20–35 MB. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const idParam = z.object({ id: z.string().uuid() });
const recipientList = z.array(z.string().max(2000)).max(1000).default([]);

interface DraftRow {
  id: string; mailbox_id: string; compose_kind: string; source_message_id: string | null; to_recipients: string[]; cc_recipients: string[];
  bcc_recipients: string[]; subject: string; text_body: string; html_body: string | null; signature_id: string | null; upload_ids: string[];
  version: number; updated_by_device: string | null; updated_at: Date; created_at: Date;
}
export const draftDto = (d: DraftRow) => ({
  id: d.id, mailboxId: d.mailbox_id, mode: d.compose_kind, sourceMessageId: d.source_message_id, to: d.to_recipients, cc: d.cc_recipients,
  bcc: d.bcc_recipients, subject: d.subject, text: d.text_body, html: d.html_body, signatureId: d.signature_id, uploadIds: d.upload_ids,
  version: d.version, updatedByDevice: d.updated_by_device, updatedAt: d.updated_at.toISOString(), createdAt: d.created_at.toISOString(),
});

const draftFields = z.object({
  mailboxId: z.string().uuid(),
  mode: z.enum(['new', 'reply', 'reply_all', 'forward']).default('new'),
  sourceMessageId: z.string().uuid().nullable().optional(),
  to: recipientList, cc: recipientList, bcc: recipientList,
  subject: z.string().max(998).default(''),
  text: z.string().max(2_000_000).default(''),
  html: z.string().max(5_000_000).nullable().optional(),
  signatureId: z.string().uuid().nullable().optional(),
  uploadIds: z.array(z.string().uuid()).max(50).default([]),
  device: z.string().max(100).optional(),
});

async function checkRefs(c: Tx, body: { mailboxId: string; signatureId?: string | null; uploadIds: string[] }) {
  if (!(await c.query(`SELECT 1 FROM mailboxes WHERE id = $1`, [body.mailboxId])).rowCount) throw new AppError(404, 'not_found', 'Mailbox not found.');
  if (body.signatureId && !(await c.query(`SELECT 1 FROM signatures WHERE id = $1`, [body.signatureId])).rowCount) throw new AppError(404, 'not_found', 'Signature not found.');
  if (body.uploadIds.length) {
    const { rows } = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM uploads WHERE id = ANY($1)`, [body.uploadIds]);
    if (rows[0]!.n !== new Set(body.uploadIds).size) throw new AppError(404, 'not_found', 'One of the attachments was not found. Upload it again.');
  }
}

export function registerComposeRoutes(app: FastifyInstance, deps: Deps) {
  const { cfg, db } = deps;
  const active = { preHandler: [app.authenticate, app.requireActive] };
  const uidOf = (req: { auth?: { user: { id: string } } }) => req.auth!.user.id;

  // ---- Uploads ------------------------------------------------------------
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));

  /** Raw file upload: PUT /v1/uploads?filename=report.pdf (body = file bytes). The real type is detected from the content. */
  app.put('/v1/uploads', { ...active, bodyLimit: MAX_UPLOAD_BYTES, config: { rateLimit: { max: 120, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const q = parse(z.object({ filename: z.string().trim().min(1).max(255), inline: z.enum(['1', '0']).optional() }), req.query);
    const data = req.body;
    if (!Buffer.isBuffer(data) || !data.length) throw new AppError(400, 'validation_failed', 'Send the file as application/octet-stream.');
    const filename = q.filename.replace(/[\\/\x00-\x1f]/g, '_').replace(/^\.+/, '_');
    const detected = detectType(data, filename);
    const risk = uploadRisk(filename, detected);
    if (q.inline === '1' && !/^image\/(png|jpeg|gif|webp)$/.test(detected.mime)) {
      throw new AppError(400, 'validation_failed', 'Only PNG, JPEG, GIF or WebP images can be placed inside the message text.');
    }
    const uid = uidOf(req);
    enforceScan(cfg, await scanBytes(cfg, data), 'this file');
    const row = await withUser(db.api, uid, async (c) => {
      const st = await storageStatus(c);
      if (st.usedBytes + data.length > st.quotaBytes) {
        throw new AppError(413, 'limit_reached', 'Your storage is full. Delete messages you no longer need, or ask the administrator for more space.');
      }
      const blob = await putBlob(c, cfg, uid, data);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO uploads (user_id, blob_id, filename, declared_mime, detected_mime, size_bytes, risk_level, inline)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [uid, blob.id, filename, (req.headers['x-content-type'] as string | undefined)?.slice(0, 127) ?? null, detected.mime, data.length, risk, q.inline === '1']);
      return rows[0]!;
    });
    return reply.code(201).send({ upload: { id: row.id, filename, mimeType: detected.mime, sizeBytes: data.length, risk } });
  });

  app.delete('/v1/uploads/:id', active, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    await withUser(db.api, uidOf(req), (c) => c.query(`DELETE FROM uploads WHERE id = $1`, [id]));
    return reply.code(204).send();
  });

  // ---- Signatures -----------------------------------------------------------
  const sigBody = z.object({ name: z.string().trim().min(1).max(80), text: z.string().max(10000), html: z.string().max(50000).nullable().optional() });

  app.get('/v1/signatures', active, async (req) => {
    const { rows } = await withUser(db.api, uidOf(req), (c) => c.query<{ id: string; name: string; text_body: string; html_body: string | null }>(
      `SELECT id, name, text_body, html_body FROM signatures ORDER BY name`));
    const defaults = await withUser(db.api, uidOf(req), (c) => c.query<{ id: string; default_signature_id: string | null }>(
      `SELECT id, default_signature_id FROM mailboxes WHERE default_signature_id IS NOT NULL`));
    return {
      signatures: rows.map((s) => ({ id: s.id, name: s.name, text: s.text_body, html: s.html_body,
        defaultFor: defaults.rows.filter((d) => d.default_signature_id === s.id).map((d) => d.id) })),
    };
  });

  app.post('/v1/signatures', active, async (req, reply) => {
    const b = parse(sigBody, req.body);
    const uid = uidOf(req);
    const { rows } = await withUser(db.api, uid, (c) => c.query<{ id: string }>(
      `INSERT INTO signatures (user_id, name, text_body, html_body) VALUES ($1, $2, $3, $4) RETURNING id`,
      [uid, b.name, b.text, b.html ? sanitizeEmailHtml(b.html).html : null]));
    return reply.code(201).send({ id: rows[0]!.id });
  });

  app.put('/v1/signatures/:id', active, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(sigBody, req.body);
    const r = await withUser(db.api, uidOf(req), (c) => c.query(
      `UPDATE signatures SET name = $2, text_body = $3, html_body = $4, updated_at = now() WHERE id = $1`,
      [id, b.name, b.text, b.html ? sanitizeEmailHtml(b.html).html : null]));
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Signature not found.');
    return { ok: true };
  });

  app.delete('/v1/signatures/:id', active, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const r = await withUser(db.api, uidOf(req), (c) => c.query(`DELETE FROM signatures WHERE id = $1`, [id]));
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Signature not found.');
    return reply.code(204).send();
  });

  app.put('/v1/mailboxes/:id/default-signature', active, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ signatureId: z.string().uuid().nullable() }), req.body);
    await withUser(db.api, uidOf(req), async (c) => {
      if (b.signatureId && !(await c.query(`SELECT 1 FROM signatures WHERE id = $1`, [b.signatureId])).rowCount) throw new AppError(404, 'not_found', 'Signature not found.');
      const r = await c.query(`UPDATE mailboxes SET default_signature_id = $2 WHERE id = $1`, [id, b.signatureId]);
      if (!r.rowCount) throw new AppError(404, 'not_found', 'Mailbox not found.');
    });
    return { ok: true };
  });

  // ---- Templates and quick replies ------------------------------------------
  const tplBody = z.object({
    kind: z.enum(['template', 'quick_reply']), name: z.string().trim().min(1).max(80), subject: z.string().max(998).nullable().optional(),
    text: z.string().max(100000), html: z.string().max(500000).nullable().optional(),
  });
  app.get('/v1/templates', active, async (req) => {
    const { rows } = await withUser(db.api, uidOf(req), (c) => c.query<{ id: string; kind: string; name: string; subject: string | null; text_body: string; html_body: string | null }>(
      `SELECT id, kind, name, subject, text_body, html_body FROM templates ORDER BY kind, name`));
    return { templates: rows.map((t) => ({ id: t.id, kind: t.kind, name: t.name, subject: t.subject, text: t.text_body, html: t.html_body })) };
  });
  app.post('/v1/templates', active, async (req, reply) => {
    const b = parse(tplBody, req.body);
    const uid = uidOf(req);
    try {
      const { rows } = await withUser(db.api, uid, (c) => c.query<{ id: string }>(
        `INSERT INTO templates (user_id, kind, name, subject, text_body, html_body) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [uid, b.kind, b.name, b.subject ?? null, b.text, b.html ? sanitizeEmailHtml(b.html).html : null]));
      return reply.code(201).send({ id: rows[0]!.id });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(409, 'conflict', 'A template with this name already exists.');
      throw err;
    }
  });
  app.put('/v1/templates/:id', active, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(tplBody, req.body);
    const r = await withUser(db.api, uidOf(req), (c) => c.query(
      `UPDATE templates SET kind = $2, name = $3, subject = $4, text_body = $5, html_body = $6, updated_at = now() WHERE id = $1`,
      [id, b.kind, b.name, b.subject ?? null, b.text, b.html ? sanitizeEmailHtml(b.html).html : null]));
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Template not found.');
    return { ok: true };
  });
  app.delete('/v1/templates/:id', active, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const r = await withUser(db.api, uidOf(req), (c) => c.query(`DELETE FROM templates WHERE id = $1`, [id]));
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Template not found.');
    return reply.code(204).send();
  });

  // ---- Drafts ---------------------------------------------------------------
  app.get('/v1/drafts', active, async (req) => {
    const { rows } = await withUser(db.api, uidOf(req), (c) => c.query<DraftRow>(`SELECT * FROM drafts ORDER BY updated_at DESC LIMIT 200`));
    return { drafts: rows.map(draftDto) };
  });

  app.get('/v1/drafts/:id', active, async (req) => {
    const { id } = parse(idParam, req.params);
    const { rows } = await withUser(db.api, uidOf(req), (c) => c.query<DraftRow>(`SELECT * FROM drafts WHERE id = $1`, [id]));
    if (!rows[0]) throw new AppError(404, 'not_found', 'Draft not found.');
    return { draft: draftDto(rows[0]) };
  });

  app.post('/v1/drafts', active, async (req, reply) => {
    const b = parse(draftFields.extend({ id: z.string().uuid().optional() }), req.body);
    const uid = uidOf(req);
    const d = await withUser(db.api, uid, async (c) => {
      await checkRefs(c, b);
      // A client-chosen id makes offline-created drafts idempotent when they are uploaded later.
      const { rows } = await c.query<DraftRow>(
        `INSERT INTO drafts (id, user_id, mailbox_id, compose_kind, source_message_id, to_recipients, cc_recipients, bcc_recipients, subject,
                text_body, html_body, signature_id, upload_ids, updated_by_device)
         VALUES (coalesce($1, gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO NOTHING RETURNING *`,
        [b.id ?? null, uid, b.mailboxId, b.mode, b.sourceMessageId ?? null, JSON.stringify(b.to), JSON.stringify(b.cc), JSON.stringify(b.bcc),
         b.subject, b.text, b.html ?? null, b.signatureId ?? null, b.uploadIds, b.device ?? null]);
      if (rows[0]) return rows[0];
      const again = await c.query<DraftRow>(`SELECT * FROM drafts WHERE id = $1`, [b.id]);
      if (!again.rows[0]) throw new AppError(409, 'conflict', 'This draft id is already used.');
      return again.rows[0];
    });
    return reply.code(201).send({ draft: draftDto(d) });
  });

  /**
   * Saves a draft. The client sends the version it last saw; if another device saved in between, the
   * save is refused with the current server copy so that nothing is silently overwritten.
   */
  app.put('/v1/drafts/:id', active, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(draftFields.extend({ version: z.number().int().min(1) }), req.body);
    const uid = uidOf(req);
    return withUser(db.api, uid, async (c) => {
      await checkRefs(c, b);
      const { rows } = await c.query<DraftRow>(
        `UPDATE drafts SET mailbox_id = $3, compose_kind = $4, source_message_id = $5, to_recipients = $6, cc_recipients = $7, bcc_recipients = $8,
                subject = $9, text_body = $10, html_body = $11, signature_id = $12, upload_ids = $13, updated_by_device = $14,
                version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2 RETURNING *`,
        [id, b.version, b.mailboxId, b.mode, b.sourceMessageId ?? null, JSON.stringify(b.to), JSON.stringify(b.cc), JSON.stringify(b.bcc),
         b.subject, b.text, b.html ?? null, b.signatureId ?? null, b.uploadIds, b.device ?? null]);
      if (rows[0]) return { draft: draftDto(rows[0]) };
      const cur = await c.query<DraftRow>(`SELECT * FROM drafts WHERE id = $1`, [id]);
      if (!cur.rows[0]) throw new AppError(404, 'not_found', 'Draft not found (it may have been sent or deleted on another device).');
      throw new AppError(409, 'conflict', 'This draft was changed on another device.', { current: draftDto(cur.rows[0]) });
    });
  });

  app.delete('/v1/drafts/:id', active, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    await withUser(db.api, uidOf(req), (c) => c.query(`DELETE FROM drafts WHERE id = $1`, [id]));
    return reply.code(204).send();
  });
}
