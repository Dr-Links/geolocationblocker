import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { checkPassword, PASSWORD_PROBLEM_TEXT, isValidTimeZone } from '@app/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { iso, toAccount, type UserRow } from '../lib/account.js';
import { audit } from '../lib/audit.js';
import type { Config } from '../lib/config.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { tx, type Db, type Tx } from '../lib/db.js';
import { emails } from '../lib/emails.js';
import { AppError, parse } from '../lib/errors.js';
import { createHttp } from '../lib/http.js';
import { sendSafely, type Mailer } from '../lib/mailer.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../lib/passwords.js';
import { enrollMfa, verifySecondFactor } from './mfa.js';
import {
  checkCsrf, clearSessionCookies, loadAdminSession, setSessionCookies, startAdminSession, type AdminSession,
} from './session.js';

export interface AdminDeps {
  cfg: Config;
  db: Db; // connects as the admin database user
  mailer: Mailer;
}

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminSession;
  }
}

const ADMIN_LOGIN_LIMIT = 5; // failures per 15 minutes per IP or per account
const uuidParam = z.object({ id: z.string().uuid() });
const mfaInput = z.object({ code: z.string().max(12).optional(), recoveryCode: z.string().max(40).optional() });

function strongAdminPassword(pw: string) {
  const problem = checkPassword(pw);
  if (problem) throw new AppError(400, 'weak_password', PASSWORD_PROBLEM_TEXT[problem]);
  if (pw.length < 14) throw new AppError(400, 'weak_password', 'The administrator password must be at least 14 characters.');
}

/** Maps errors raised by app.grant_access() to friendly API errors. */
function grantError(err: unknown): never {
  const msg = (err as { message?: string }).message ?? '';
  const map: Record<string, [number, string]> = {
    user_not_found: [404, 'User not found.'],
    not_pending: [409, 'Only pending registrations can be approved.'],
    email_not_verified: [409, 'This user has not confirmed their email address yet.'],
    not_renewable: [409, 'Only approved or suspended accounts can be renewed.'],
    period_already_over: [409, 'Extending from the previous expiry would end in the past. Renew from now instead.'],
  };
  const hit = map[msg];
  if (hit) throw new AppError(hit[0], hit[0] === 404 ? 'not_found' : 'conflict', hit[1]);
  throw err;
}

export async function buildAdminApi(deps: AdminDeps): Promise<FastifyInstance> {
  const { cfg, db, mailer } = deps;
  const staticDir = cfg.adminStaticDir && existsSync(join(cfg.adminStaticDir, 'index.html')) ? cfg.adminStaticDir : undefined;

  const app = await createHttp(cfg, {
    notFound: (req, reply) => {
      // Single-page app: unknown non-API GET paths serve index.html.
      if (staticDir && req.method === 'GET' && !req.url.startsWith('/admin/api/')) {
        return reply.header('cache-control', 'no-cache').sendFile('index.html');
      }
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
    },
  });
  await app.register(cookie);
  app.decorateRequest('admin', undefined);

  if (staticDir) {
    await app.register(fastifyStatic, { root: staticDir, prefix: '/', index: ['index.html'], cacheControl: false });
    app.addHook('onSend', async (req, reply) => {
      if (!req.url.startsWith('/admin/api/')) {
        reply.header('content-security-policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        if (/\/assets\//.test(req.url)) reply.header('cache-control', 'public, max-age=31536000, immutable');
      }
    });
  }

  const warn = (m: string) => app.log.warn(m);
  const originOnly = async (req: FastifyRequest) => {
    const origin = req.headers.origin;
    if (origin && origin !== new URL(cfg.adminWebUrl).origin) throw new AppError(403, 'csrf_failed', 'Request origin not allowed.');
  };
  const requireAdmin = async (req: FastifyRequest) => {
    const s = await loadAdminSession(db, cfg, req);
    if (!s) throw new AppError(401, 'unauthorized', 'Please sign in.');
    if (!s.mfaVerified) throw new AppError(401, 'mfa_required', 'Enter your authenticator code.');
    checkCsrf(cfg, req);
    req.admin = s;
  };
  const guarded = { preHandler: requireAdmin };
  const adminTx = <T>(req: FastifyRequest, fn: (c: Tx, admin: AdminSession) => Promise<T>) => tx(db, (c) => fn(c, req.admin!));

  const recordAttempt = (c: Tx | Db, email: string, userId: string | null, ip: string, surface: 'admin' | 'admin_mfa', success: boolean, reason?: string) =>
    c.query(`INSERT INTO login_attempts (email_normalized, user_id, ip, surface, success, failure_reason) VALUES ($1, $2, $3, $4, $5, $6)`,
      [email, userId, ip, surface, success, reason ?? null]);

  const throttled = async (email: string, ip: string) => {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM login_attempts
        WHERE surface IN ('admin','admin_mfa') AND NOT success AND created_at > now() - interval '15 minutes'
          AND (ip = $1 OR email_normalized = $2)`, [ip, email]);
    if ((rows[0]?.n ?? 0) >= ADMIN_LOGIN_LIMIT) {
      throw new AppError(429, 'too_many_attempts', 'Too many failed attempts. Wait 15 minutes and try again.', undefined, { 'retry-after': '900' });
    }
  };

  // ===========================================================================
  // Authentication
  // ===========================================================================
  app.post('/admin/api/auth/login', { preHandler: originOnly, config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const body = parse(z.object({ email: z.string().trim().toLowerCase().max(254), password: z.string().max(1024) }), req.body);
    await throttled(body.email, req.ip);
    const { rows } = await db.query<{ id: string; password_hash: string; email_normalized: string }>(
      `SELECT id, password_hash, email_normalized FROM users WHERE role = 'admin' AND email_normalized = $1`, [body.email]);
    const admin = rows[0];
    if (!admin || !(await verifyPassword(admin.password_hash, body.password))) {
      if (!admin) await burnPasswordCheck(body.password);
      await recordAttempt(db, body.email, admin?.id ?? null, req.ip, 'admin', false, 'bad_credentials');
      throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect.');
    }
    const token = await tx(db, (c) => startAdminSession(c, req, admin.id, false));
    setSessionCookies(reply, cfg, token, true);
    return { mfaRequired: true };
  });

  app.post('/admin/api/auth/mfa', { preHandler: originOnly, config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const body = parse(mfaInput, req.body);
    const s = await loadAdminSession(db, cfg, req);
    if (!s) throw new AppError(401, 'unauthorized', 'Your sign-in expired. Start again.');
    await throttled(s.email, req.ip);
    let method: string;
    try {
      method = await tx(db, (c) => verifySecondFactor(c, cfg, s.userId, body));
    } catch (err) {
      await recordAttempt(db, s.email, s.userId, req.ip, 'admin_mfa', false, 'bad_code');
      throw err;
    }
    // New session token after the second factor (prevents session fixation).
    const token = await tx(db, async (c) => {
      await c.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'mfa_upgraded' WHERE id = $1`, [s.sessionId]);
      const t = await startAdminSession(c, req, s.userId, true);
      await recordAttempt(c, s.email, s.userId, req.ip, 'admin_mfa', true);
      await c.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [s.userId]);
      await audit(c, { actorType: 'admin', actorUserId: s.userId, action: 'admin.login', ip: req.ip, details: { method } });
      return t;
    });
    setSessionCookies(reply, cfg, token, true);
    return { ok: true };
  });

  app.post('/admin/api/auth/logout', guarded, async (req, reply) => {
    await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1`, [req.admin!.sessionId]);
    clearSessionCookies(reply, cfg);
    return reply.code(204).send();
  });

  app.get('/admin/api/me', guarded, async (req) => {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM mfa_factors WHERE user_id = $1 AND kind = 'recovery_code' AND used_at IS NULL`, [req.admin!.userId]);
    return { email: req.admin!.email, recoveryCodesRemaining: rows[0]?.n ?? 0 };
  });

  app.post('/admin/api/me/password', guarded, async (req) => {
    const body = parse(z.object({ currentPassword: z.string().max(1024), newPassword: z.string().max(1024) }).merge(mfaInput), req.body);
    strongAdminPassword(body.newPassword);
    await adminTx(req, async (c, a) => {
      const { rows } = await c.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [a.userId]);
      if (!rows[0] || !(await verifyPassword(rows[0].password_hash, body.currentPassword))) {
        throw new AppError(400, 'invalid_credentials', 'Current password is incorrect.');
      }
      await verifySecondFactor(c, cfg, a.userId, body);
      await c.query(`UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1`, [a.userId, await hashPassword(body.newPassword)]);
      await c.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_changed' WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [a.userId, a.sessionId]);
      await audit(c, { actorType: 'admin', actorUserId: a.userId, action: 'admin.password_changed', ip: req.ip });
    });
    return { ok: true };
  });

  app.post('/admin/api/me/recovery-codes', guarded, async (req) => {
    const body = parse(mfaInput, req.body);
    const enrollment = await adminTx(req, async (c, a) => {
      await verifySecondFactor(c, cfg, a.userId, body);
      const e = await enrollMfa(c, cfg, a.userId, a.email);
      await audit(c, { actorType: 'admin', actorUserId: a.userId, action: 'admin.mfa_reenrolled', ip: req.ip });
      return e;
    });
    return enrollment;
  });

  // Password recovery through the designated administrator email address.
  app.post('/admin/api/auth/password-reset/request', { preHandler: originOnly, config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req, reply) => {
    const body = parse(z.object({ email: z.string().trim().toLowerCase().max(254) }), req.body);
    const mail = await tx(db, async (c) => {
      const { rows } = await c.query<{ id: string; email_display: string; notify: string | null }>(
        `SELECT u.id, u.email_display, s.admin_notify_email AS notify FROM users u, platform_settings s
          WHERE u.role = 'admin' AND u.email_normalized = $1`, [body.email]);
      const a = rows[0];
      if (!a) return null;
      await c.query(`UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND purpose = 'admin_recovery' AND used_at IS NULL`, [a.id]);
      const token = randomToken();
      await c.query(`INSERT INTO auth_tokens (user_id, purpose, token_hash, created_ip, expires_at)
                     VALUES ($1, 'admin_recovery', $2, $3, now() + interval '30 minutes')`, [a.id, sha256(token), req.ip]);
      await audit(c, { actorType: 'system', action: 'admin.password_reset_requested', ip: req.ip });
      return emails.adminPasswordReset(a.notify ?? a.email_display, `${cfg.adminWebUrl}/reset?token=${token}`);
    });
    if (mail) await sendSafely(mailer, mail, warn);
    return reply.code(202).send({ message: 'If that is the administrator address, a reset link has been sent to the recovery email.' });
  });

  app.post('/admin/api/auth/password-reset/confirm', { preHandler: originOnly, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req) => {
    const body = parse(z.object({ token: z.string().min(10).max(200), newPassword: z.string().max(1024) }).merge(mfaInput), req.body);
    strongAdminPassword(body.newPassword);
    await tx(db, async (c) => {
      const { rows } = await c.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM auth_tokens WHERE token_hash = $1 AND purpose = 'admin_recovery' AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
        [sha256(body.token)]);
      const t = rows[0];
      if (!t) throw new AppError(400, 'invalid_token', 'This link is invalid or has expired.');
      await verifySecondFactor(c, cfg, t.user_id, body);
      await c.query(`UPDATE auth_tokens SET used_at = now() WHERE id = $1`, [t.id]);
      await c.query(`UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1`, [t.user_id, await hashPassword(body.newPassword)]);
      await c.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_reset' WHERE user_id = $1 AND revoked_at IS NULL`, [t.user_id]);
      await audit(c, { actorType: 'admin', actorUserId: t.user_id, action: 'admin.password_reset', ip: req.ip });
    });
    return { ok: true };
  });

  // Emergency recovery: the token can only be created with server or database access (see docs).
  app.post('/admin/api/auth/emergency', { preHandler: originOnly, config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req) => {
    const body = parse(z.object({ token: z.string().min(10).max(200), newPassword: z.string().max(1024) }), req.body);
    strongAdminPassword(body.newPassword);
    return tx(db, async (c) => {
      const { rows } = await c.query<{ user_id: string; email_display: string }>(
        `UPDATE auth_tokens t SET used_at = now() FROM users u
          WHERE t.token_hash = $1 AND t.purpose = 'admin_emergency' AND t.used_at IS NULL AND t.expires_at > now()
            AND u.id = t.user_id AND u.role = 'admin'
          RETURNING t.user_id, u.email_display`, [sha256(body.token)]);
      const t = rows[0];
      if (!t) throw new AppError(400, 'invalid_token', 'This emergency link is invalid or has expired. Generate a new one on the server.');
      await c.query(`UPDATE users SET password_hash = $2, password_changed_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1`,
        [t.user_id, await hashPassword(body.newPassword)]);
      await c.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'emergency_recovery' WHERE user_id = $1 AND revoked_at IS NULL`, [t.user_id]);
      const enrollment = await enrollMfa(c, cfg, t.user_id, t.email_display);
      await audit(c, { actorType: 'admin', actorUserId: t.user_id, action: 'admin.emergency_recovery', ip: req.ip });
      return enrollment;
    });
  });

  // ===========================================================================
  // Dashboard and users
  // ===========================================================================
  app.get('/admin/api/dashboard', guarded, async () => {
    const { rows: counts } = await db.query<{ status: string; verified: boolean; n: number }>(
      `SELECT status, email_verified_at IS NOT NULL AS verified, count(*)::int AS n FROM users WHERE role = 'user' GROUP BY 1, 2`);
    const { rows: expiring } = await db.query<{ id: string; email_display: string; access_expires_at: Date }>(
      `SELECT id, email_display, access_expires_at FROM users
        WHERE role = 'user' AND status = 'approved' AND access_expires_at < now() + interval '7 days'
        ORDER BY access_expires_at LIMIT 50`);
    const { rows: fails } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM login_attempts WHERE NOT success AND created_at > now() - interval '24 hours'`);
    const sum = (pred: (r: { status: string; verified: boolean }) => boolean) => counts.filter(pred).reduce((a, r) => a + r.n, 0);
    return {
      counts: {
        pendingVerified: sum((r) => r.status === 'pending' && r.verified),
        pendingUnverified: sum((r) => r.status === 'pending' && !r.verified),
        approved: sum((r) => r.status === 'approved'),
        suspended: sum((r) => r.status === 'suspended'),
        rejected: sum((r) => r.status === 'rejected'),
      },
      expiringSoon: expiring.map((e) => ({ id: e.id, email: e.email_display, accessExpiresAt: iso(e.access_expires_at) })),
      failedLogins24h: fails[0]?.n ?? 0,
    };
  });

  app.get('/admin/api/users', guarded, async (req) => {
    const q = parse(z.object({
      status: z.enum(['all', 'pending', 'approved', 'suspended', 'rejected', 'expired']).default('all'),
      search: z.string().max(100).optional(),
      offset: z.coerce.number().int().min(0).default(0),
    }), req.query);
    const where: string[] = [`role = 'user'`, `status <> 'deleting'`];
    const params: unknown[] = [];
    if (q.status === 'expired') where.push(`(status = 'suspended' AND suspension_reason = 'expired')`);
    else if (q.status !== 'all') { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.search) { params.push(`%${q.search.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`); where.push(`email_display LIKE $${params.length}`); }
    params.push(q.offset);
    const { rows } = await db.query<UserRow & { last_login_at: Date | null }>(
      `SELECT * FROM users WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 50 OFFSET $${params.length}`, params);
    return {
      users: rows.map((u) => ({ ...toAccount(u), suspensionReason: u.suspension_reason, lastLoginAt: iso(u.last_login_at) })),
      nextOffset: rows.length === 50 ? q.offset + 50 : null,
    };
  });

  app.get('/admin/api/users/:id', guarded, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const { rows } = await db.query<UserRow & { last_login_at: Date | null; storage_quota_bytes: number | null; suspended_at: Date | null; rejected_at: Date | null }>(
      `SELECT * FROM users WHERE id = $1 AND role = 'user'`, [id]);
    const u = rows[0];
    if (!u) throw new AppError(404, 'not_found', 'User not found.');
    const [periods, sessions, events, settings] = await Promise.all([
      db.query<{ kind: string; starts_at: Date; ends_at: Date; timezone_used: string; payment_note: string | null; created_at: Date }>(
        `SELECT kind, starts_at, ends_at, timezone_used, payment_note, created_at FROM access_periods WHERE user_id = $1 ORDER BY created_at DESC`, [id]),
      db.query<{ id: string; kind: string; created_at: Date; last_used_at: Date; ip: string | null; name: string | null; platform: string | null }>(
        `SELECT s.id, s.kind, s.created_at, s.last_used_at, host(s.ip) AS ip, d.name, d.platform
           FROM sessions s LEFT JOIN devices d ON d.id = s.device_id
          WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() ORDER BY s.last_used_at DESC`, [id]),
      db.query<{ occurred_at: Date; actor_type: string; action: string; details: unknown }>(
        `SELECT occurred_at, actor_type, action, details FROM audit_log WHERE target_user_id = $1 ORDER BY occurred_at DESC LIMIT 50`, [id]),
      db.query<{ default_quota_bytes: number }>(`SELECT default_quota_bytes FROM platform_settings`),
    ]);
    return {
      user: {
        ...toAccount(u),
        suspensionReason: u.suspension_reason,
        lastLoginAt: iso(u.last_login_at),
        suspendedAt: iso(u.suspended_at),
        rejectedAt: iso(u.rejected_at),
        storageQuotaBytes: u.storage_quota_bytes,
        effectiveQuotaBytes: u.storage_quota_bytes ?? settings.rows[0]?.default_quota_bytes ?? null,
      },
      accessPeriods: periods.rows.map((p) => ({ kind: p.kind, startsAt: iso(p.starts_at), endsAt: iso(p.ends_at), timezone: p.timezone_used, paymentNote: p.payment_note, createdAt: iso(p.created_at) })),
      sessions: sessions.rows.map((s) => ({ id: s.id, kind: s.kind, createdAt: iso(s.created_at), lastUsedAt: iso(s.last_used_at), ip: s.ip, deviceName: s.name, platform: s.platform })),
      mailboxes: [] as unknown[], // Milestone 2: connection metadata and health only, never content
      activity: events.rows.map((e) => ({ occurredAt: iso(e.occurred_at), actorType: e.actor_type, action: e.action, details: e.details })),
    };
  });

  const loadUser = async (c: Tx, id: string) => {
    const { rows } = await c.query<UserRow>(`SELECT * FROM users WHERE id = $1 AND role = 'user' FOR UPDATE`, [id]);
    if (!rows[0]) throw new AppError(404, 'not_found', 'User not found.');
    return rows[0];
  };

  app.post('/admin/api/users/:id/approve', guarded, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ paymentNote: z.string().max(500).optional() }), req.body);
    const result = await adminTx(req, async (c, a) => {
      const u = await loadUser(c, id);
      const { rows } = await c.query<{ starts_at: Date; ends_at: Date; timezone_used: string }>(
        `SELECT * FROM app.grant_access($1, $2, 'approve', $3)`, [id, a.userId, body.paymentNote ?? null]).catch(grantError);
      await audit(c, { actorType: 'admin', actorUserId: a.userId, action: 'user.approved', targetType: 'user', targetId: id, targetUserId: id, ip: req.ip,
        details: { ends_at: rows[0]!.ends_at, timezone: rows[0]!.timezone_used } });
      return { user: u, period: rows[0]! };
    });
    await sendSafely(mailer, emails.approved(result.user.email_display, result.period.ends_at, result.period.timezone_used), warn);
    return { accessExpiresAt: iso(result.period.ends_at), timezone: result.period.timezone_used };
  });

  app.post('/admin/api/users/:id/renew', guarded, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ mode: z.enum(['from_now', 'from_current_expiry']), paymentNote: z.string().max(500).optional() }), req.body);
    const result = await adminTx(req, async (c, a) => {
      const u = await loadUser(c, id);
      const { rows } = await c.query<{ starts_at: Date; ends_at: Date; timezone_used: string; previous_status: string }>(
        `SELECT * FROM app.grant_access($1, $2, $3, $4)`, [id, a.userId, body.mode, body.paymentNote ?? null]).catch(grantError);
      await audit(c, { actorType: 'admin', actorUserId: a.userId, action: rows[0]!.previous_status === 'suspended' ? 'user.reactivated' : 'user.renewed',
        targetType: 'user', targetId: id, targetUserId: id, ip: req.ip, details: { mode: body.mode, ends_at: rows[0]!.ends_at } });
      return { user: u, period: rows[0]! };
    });
    await sendSafely(mailer, emails.renewed(result.user.email_display, result.period.ends_at, result.period.timezone_used), warn);
    return { accessExpiresAt: iso(result.period.ends_at), timezone: result.period.timezone_used };
  });

  app.post('/admin/api/users/:id/reject', guarded, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const u = await adminTx(req, async (c, a) => {
      const user = await loadUser(c, id);
      if (user.status !== 'pending') throw new AppError(409, 'conflict', 'Only pending registrations can be rejected.');
      await c.query(`UPDATE users SET status = 'rejected', rejected_at = now() WHERE id = $1`, [id]);
      await c.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'account_rejected' WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
      await audit(c, { actorType: 'admin', actorUserId: a.userId, action: 'user.rejected', targetType: 'user', targetId: id, targetUserId: id, ip: req.ip });
      return user;
    });
    if (u.email_verified_at) await sendSafely(mailer, emails.rejected(u.email_display), warn);
    return { ok: true };
  });

  app.post('/admin/api/users/:id/suspend', guarded, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const u = await adminTx(req, async (c, a) => {
      const user = await loadUser(c, id);
      const { rows } = await c.query<{ ok: boolean }>(`SELECT app.apply_suspension($1, 'admin_action') AS ok`, [id]);
      if (!rows[0]?.ok) throw new AppError(409, 'conflict', 'Only approved accounts can be suspended.');
      await audit(c, { actorType: 'admin', actorUserId: a.userId, action: 'user.suspended', targetType: 'user', targetId: id, targetUserId: id, ip: req.ip });
      return user;
    });
    await sendSafely(mailer, emails.suspended(u.email_display), warn);
    return { ok: true };
  });

  app.post('/admin/api/users/:id/revoke-sessions', guarded, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const n = await adminTx(req, async (c, a) => {
      await loadUser(c, id);
      const r = await c.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'revoked_by_admin' WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
      await audit(c, { actorType: 'admin', actorUserId: a.userId, action: 'user.sessions_revoked', targetType: 'user', targetId: id, targetUserId: id, ip: req.ip, details: { count: r.rowCount } });
      return r.rowCount ?? 0;
    });
    return { revoked: n };
  });

  // The admin never sees or sets user passwords; the user gets a reset link at their Gmail address.
  app.post('/admin/api/users/:id/password-reset', guarded, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const mail = await adminTx(req, async (c, a) => {
      const u = await loadUser(c, id);
      await c.query(`UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND purpose = 'password_reset' AND used_at IS NULL`, [id]);
      const token = randomToken();
      await c.query(`INSERT INTO auth_tokens (user_id, purpose, token_hash, created_ip, expires_at)
                     VALUES ($1, 'password_reset', $2, $3, now() + interval '30 minutes')`, [id, sha256(token), req.ip]);
      await audit(c, { actorType: 'admin', actorUserId: a.userId, action: 'user.password_reset_sent', targetType: 'user', targetId: id, targetUserId: id, ip: req.ip });
      return emails.passwordReset(u.email_display, `${cfg.publicApiUrl}/v1/pages/reset-password?token=${token}`);
    });
    const sent = await sendSafely(mailer, mail, warn);
    if (!sent) throw new AppError(502, 'internal_error', 'The reset email could not be sent. Check the SMTP settings.');
    return { ok: true };
  });

  app.patch('/admin/api/users/:id/quota', guarded, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ quotaBytes: z.number().int().min(0).max(2 ** 50).nullable() }), req.body);
    await adminTx(req, async (c, a) => {
      await loadUser(c, id);
      await c.query(`UPDATE users SET storage_quota_bytes = $2 WHERE id = $1`, [id, body.quotaBytes]);
      await audit(c, { actorType: 'admin', actorUserId: a.userId, action: 'user.quota_changed', targetType: 'user', targetId: id, targetUserId: id, ip: req.ip, details: { quota_bytes: body.quotaBytes } });
    });
    return { ok: true };
  });

  // Permanent deletion: requires typing the user's email and a fresh authenticator code.
  app.post('/admin/api/users/:id/delete', guarded, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ confirmEmail: z.string().trim().toLowerCase().max(254) }).merge(mfaInput), req.body);
    await adminTx(req, async (c, a) => {
      const u = await loadUser(c, id);
      if (body.confirmEmail !== u.email_display.toLowerCase()) {
        throw new AppError(400, 'validation_failed', 'The email address you typed does not match this user.');
      }
      await verifySecondFactor(c, cfg, a.userId, body);
      await c.query(`INSERT INTO deletion_requests (subject_type, subject_id, user_id, mode, requested_by, status, completed_at)
                     VALUES ('user', $1, $1, 'purge', $2, 'completed', now())`, [id, a.userId]);
      // Cascades to every user-owned table. Later milestones also remove stored files and mailbox data.
      await c.query(`DELETE FROM users WHERE id = $1 AND role = 'user'`, [id]);
      await audit(c, { actorType: 'admin', actorUserId: a.userId, action: 'user.deleted', targetType: 'user', targetId: id, targetUserId: id, ip: req.ip });
    });
    return { ok: true };
  });

  app.get('/admin/api/audit', guarded, async (req) => {
    const q = parse(z.object({ before: z.coerce.number().int().positive().optional() }), req.query);
    const { rows } = await db.query<{ id: number; occurred_at: Date; actor_type: string; action: string; target_user_id: string | null; ip: string | null; details: unknown; target_email: string | null }>(
      `SELECT a.id, a.occurred_at, a.actor_type, a.action, a.target_user_id, host(a.ip) AS ip, a.details, u.email_display AS target_email
         FROM audit_log a LEFT JOIN users u ON u.id = a.target_user_id
        WHERE ($1::bigint IS NULL OR a.id < $1) ORDER BY a.id DESC LIMIT 100`, [q.before ?? null]);
    return {
      entries: rows.map((r) => ({ id: r.id, occurredAt: iso(r.occurred_at), actorType: r.actor_type, action: r.action, targetUserId: r.target_user_id, targetEmail: r.target_email, ip: r.ip, details: r.details })),
      nextBefore: rows.length === 100 ? rows[rows.length - 1]!.id : null,
    };
  });

  app.get('/admin/api/settings', guarded, async () => {
    const { rows } = await db.query<{ default_timezone: string; default_quota_bytes: number; admin_notify_email: string | null }>(
      `SELECT default_timezone, default_quota_bytes, admin_notify_email FROM platform_settings`);
    const s = rows[0]!;
    return { defaultTimezone: s.default_timezone, defaultQuotaBytes: s.default_quota_bytes, adminNotifyEmail: s.admin_notify_email };
  });

  app.patch('/admin/api/settings', guarded, async (req) => {
    const body = parse(z.object({
      defaultTimezone: z.string().max(64).optional(),
      defaultQuotaBytes: z.number().int().positive().max(2 ** 50).optional(),
      adminNotifyEmail: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
    }), req.body);
    if (body.defaultTimezone && !isValidTimeZone(body.defaultTimezone)) throw new AppError(400, 'validation_failed', 'Unknown time zone.');
    await adminTx(req, async (c, a) => {
      await c.query(
        `UPDATE platform_settings SET default_timezone = coalesce($1, default_timezone),
                default_quota_bytes = coalesce($2, default_quota_bytes),
                admin_notify_email = CASE WHEN $4 THEN $3 ELSE admin_notify_email END, updated_at = now()`,
        [body.defaultTimezone ?? null, body.defaultQuotaBytes ?? null, body.adminNotifyEmail ?? null, body.adminNotifyEmail !== undefined]);
      await audit(c, { actorType: 'admin', actorUserId: a.userId, action: 'settings.updated', ip: req.ip, details: body });
    });
    return { ok: true };
  });

  return app;
}

export type { FastifyReply };
