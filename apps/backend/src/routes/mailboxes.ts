import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { withUser } from '../lib/db.js';
import { AppError, parse } from '../lib/errors.js';
import { ConnectFailure, verifyMailbox, type VerifiedMailbox } from '../mail/connect.js';
import { discover } from '../mail/discovery.js';
import type { MailboxSettings, Pins } from '../mail/settings.js';
import {
  getMailbox, insertMailbox, listMailboxes, loadSecrets, MAX_MAILBOXES_PER_USER, pinsOf, recordFailure, recordSuccess,
  settingsOf, toMailboxDto, updateVerified, validatePin,
} from '../mailboxes/repo.js';
import { MailError } from '../mail/errors.js';
import type { Deps } from '../app.js';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(1).max(1024);
const server = z.object({
  host: z.string().trim().toLowerCase().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['tls', 'starttls']),
  username: z.string().trim().min(1).max(254),
});
const manual = z.object({ imap: server, smtp: server });
const pin = z.object({ sha256: z.string().max(200), pem: z.string().max(20000) });
const trust = z.object({ imap: pin.optional(), smtp: pin.optional() }).optional();
const idParam = z.object({ id: z.string().uuid() });

function connectError(err: unknown): never {
  if (err instanceof ConnectFailure || err instanceof MailError) {
    const e = err instanceof ConnectFailure ? err.error : err;
    const hint = err instanceof ConnectFailure ? err.hint : undefined;
    throw new AppError(422, 'mailbox_connect_failed', e.message, {
      stage: e.stage,
      reason: e.code,
      certificate: e.certificate,
      provider: hint ? { name: hint.name, requiresAppPassword: !!hint.requiresAppPassword, requiresOAuth: !!hint.requiresOAuth, helpUrl: hint.helpUrl } : undefined,
      triedAutomatic: err instanceof ConnectFailure ? err.triedAutomatic : false,
    });
  }
  throw err;
}

function pinsFrom(input: z.infer<typeof trust>, fallback: Pins = {}): Pins {
  return {
    imap: input?.imap ? validatePin(input.imap) : fallback.imap ?? null,
    smtp: input?.smtp ? validatePin(input.smtp) : fallback.smtp ?? null,
  };
}

export function registerMailboxRoutes(app: FastifyInstance, deps: Deps) {
  const { cfg, db } = deps;
  const active = { preHandler: [app.authenticate, app.requireActive] };
  // Each attempt contacts outside servers; keep it modest per user and per IP.
  const connectLimit = { ...active, config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } };
  const userId = (req: { auth?: { user: { id: string } } }) => req.auth!.user.id;

  app.get('/v1/mailboxes', active, async (req) => {
    const rows = await withUser(db.api, userId(req), (c) => listMailboxes(c));
    return { mailboxes: rows.map(toMailboxDto) };
  });

  app.get('/v1/mailboxes/:id', active, async (req) => {
    const { id } = parse(idParam, req.params);
    return withUser(db.api, userId(req), async (c) => {
      const m = await getMailbox(c, id);
      if (!m) throw new AppError(404, 'not_found', 'Mailbox not found.');
      const { rows } = await c.query<{ category: string; severity: string; code: string; detail: string | null; occurred_at: Date; resolved_at: Date | null }>(
        `SELECT category, severity, code, detail, occurred_at, resolved_at FROM mailbox_events WHERE mailbox_id = $1 ORDER BY occurred_at DESC LIMIT 20`, [id]);
      return {
        mailbox: toMailboxDto(m),
        events: rows.map((e) => ({ ...e, occurred_at: undefined, resolved_at: undefined, occurredAt: e.occurred_at.toISOString(), resolvedAt: e.resolved_at?.toISOString() ?? null })),
      };
    });
  });

  /** Shows the settings that would be tried, without contacting anything with the password. */
  app.post('/v1/mailboxes/discover', connectLimit, async (req) => {
    const body = parse(z.object({ email }), req.body);
    const r = await discover(body.email, deps.discovery);
    return {
      candidates: r.candidates.slice(0, 6).map((c) => ({ source: c.source, provider: c.provider ?? null, ...c.settings })),
      provider: r.hint ? { name: r.hint.name, requiresAppPassword: !!r.hint.requiresAppPassword, requiresOAuth: !!r.hint.requiresOAuth, helpUrl: r.hint.helpUrl ?? null } : null,
    };
  });

  app.post('/v1/mailboxes', connectLimit, async (req, reply) => {
    const body = parse(z.object({
      email, password, smtpPassword: password.optional(), displayName: z.string().trim().max(100).optional(),
      manual: manual.optional(), trustCertificate: trust,
    }), req.body);
    const uid = userId(req);
    const existing = await withUser(db.api, uid, (c) => c.query<{ n: number; dup: boolean }>(
      `SELECT count(*) FILTER (WHERE status <> 'disconnected')::int AS n,
              bool_or(email_address = $1 AND status <> 'disconnected') AS dup FROM mailboxes`, [body.email]));
    if (existing.rows[0]?.dup) throw new AppError(409, 'conflict', 'This mailbox is already connected.');
    if ((existing.rows[0]?.n ?? 0) >= MAX_MAILBOXES_PER_USER) throw new AppError(409, 'limit_reached', `You can connect up to ${MAX_MAILBOXES_PER_USER} mailboxes.`);

    const pins = pinsFrom(body.trustCertificate);
    const secrets = { imapPassword: body.password, smtpPassword: body.smtpPassword ?? null };
    let verified: VerifiedMailbox;
    try {
      verified = await verifyMailbox(cfg, body.email, secrets, { manual: body.manual as MailboxSettings | undefined, pins, deps: deps.discovery });
    } catch (err) {
      connectError(err);
    }
    const id = await withUser(db.api, uid, async (c) => {
      try {
        const newId = await insertMailbox(c, cfg, uid, body.email, body.displayName || null, verified, secrets, pins);
        await audit(c, { actorType: 'user', actorUserId: uid, action: 'mailbox.connected', targetType: 'mailbox', targetId: newId, targetUserId: uid, ip: req.ip,
          details: { imap_host: verified.settings.imap.host, smtp_host: verified.settings.smtp.host, discovered_via: verified.discoveredVia } });
        return newId;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new AppError(409, 'conflict', 'This mailbox is already connected.');
        throw err;
      }
    });
    const m = await withUser(db.api, uid, (c) => getMailbox(c, id));
    return reply.code(201).send({ mailbox: toMailboxDto(m!) });
  });

  app.patch('/v1/mailboxes/:id', active, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({
      displayName: z.string().trim().max(100).nullable().optional(),
      labelColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    }), req.body);
    return withUser(db.api, userId(req), async (c) => {
      const r = await c.query(
        `UPDATE mailboxes SET display_name = CASE WHEN $2 THEN $3 ELSE display_name END,
                label_color = CASE WHEN $4 THEN $5 ELSE label_color END WHERE id = $1`,
        [id, body.displayName !== undefined, body.displayName || null, body.labelColor !== undefined, body.labelColor ?? null]);
      if (!r.rowCount) throw new AppError(404, 'not_found', 'Mailbox not found.');
      return { mailbox: toMailboxDto((await getMailbox(c, id))!) };
    });
  });

  /** New password (e.g. after changing it at the email provider) and/or new server settings. */
  app.put('/v1/mailboxes/:id/connection', connectLimit, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ password, smtpPassword: password.optional(), manual: manual.optional(), trustCertificate: trust }), req.body);
    const uid = userId(req);
    const m = await withUser(db.api, uid, (c) => getMailbox(c, id));
    if (!m) throw new AppError(404, 'not_found', 'Mailbox not found.');
    if (m.status === 'disconnected') throw new AppError(409, 'conflict', 'This mailbox is disconnected. Connect it again from "Add mailbox".');
    const pins = pinsFrom(body.trustCertificate, body.manual ? {} : pinsOf(m));
    const secrets = { imapPassword: body.password, smtpPassword: body.smtpPassword ?? null };
    let verified: VerifiedMailbox;
    try {
      verified = await verifyMailbox(cfg, m.email_address, secrets, { manual: (body.manual as MailboxSettings | undefined) ?? settingsOf(m), pins, deps: deps.discovery });
    } catch (err) {
      connectError(err);
    }
    return withUser(db.api, uid, async (c) => {
      const current = await getMailbox(c, id, true);
      if (!current) throw new AppError(404, 'not_found', 'Mailbox not found.');
      await updateVerified(c, cfg, current, verified, secrets, pins);
      await audit(c, { actorType: 'user', actorUserId: uid, action: body.manual ? 'mailbox.settings_changed' : 'mailbox.credentials_updated',
        targetType: 'mailbox', targetId: id, targetUserId: uid, ip: req.ip });
      return { mailbox: toMailboxDto((await getMailbox(c, id))!) };
    });
  });

  /** Re-tests the stored settings now (the "Test connection" button). */
  app.post('/v1/mailboxes/:id/test', connectLimit, async (req) => {
    const { id } = parse(idParam, req.params);
    const uid = userId(req);
    const loaded = await withUser(db.api, uid, async (c) => {
      const m = await getMailbox(c, id);
      return m ? { m, secrets: await loadSecrets(c, cfg, id) } : null;
    });
    if (!loaded) throw new AppError(404, 'not_found', 'Mailbox not found.');
    if (!loaded.secrets) throw new AppError(409, 'conflict', 'This mailbox has no saved password. Enter it again.');
    try {
      await verifyMailbox(cfg, loaded.m.email_address, loaded.secrets, { manual: settingsOf(loaded.m), pins: pinsOf(loaded.m), deps: deps.discovery });
      await withUser(db.api, uid, (c) => recordSuccess(c, loaded.m));
    } catch (err) {
      const e = err instanceof ConnectFailure ? err.error : err;
      if (e instanceof MailError) await withUser(db.api, uid, (c) => recordFailure(c, loaded.m, e));
      connectError(err);
    }
    return { mailbox: toMailboxDto((await withUser(db.api, uid, (c) => getMailbox(c, id)))!) };
  });

  /**
   * Disconnect. "keep": credentials are deleted and syncing stops, stored copies stay readable.
   * "delete": the mailbox and everything stored on this platform for it are deleted.
   * Neither touches the mailbox or its messages on the email provider.
   */
  app.post('/v1/mailboxes/:id/disconnect', active, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ mode: z.enum(['keep', 'delete']), confirmEmail: email }), req.body);
    const uid = userId(req);
    await withUser(db.api, uid, async (c) => {
      const m = await getMailbox(c, id, true);
      if (!m) throw new AppError(404, 'not_found', 'Mailbox not found.');
      if (body.confirmEmail !== m.email_address) throw new AppError(400, 'validation_failed', 'The address you typed does not match this mailbox.');
      if (body.mode === 'keep') {
        await c.query(`DELETE FROM mailbox_credentials WHERE mailbox_id = $1`, [id]);
        await c.query(`UPDATE mailboxes SET status = 'disconnected', disconnected_at = now(), next_retry_at = NULL,
                              generation = generation + 1 WHERE id = $1`, [id]);
      } else {
        await c.query(`DELETE FROM mailboxes WHERE id = $1`, [id]);
      }
      await audit(c, { actorType: 'user', actorUserId: uid, action: body.mode === 'keep' ? 'mailbox.disconnected' : 'mailbox.deleted',
        targetType: 'mailbox', targetId: id, targetUserId: uid, ip: req.ip });
    });
    return { ok: true };
  });
}

