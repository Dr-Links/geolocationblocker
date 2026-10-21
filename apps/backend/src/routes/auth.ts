import { randomUUID } from 'node:crypto';
import { PASSWORD_PROBLEM_TEXT, checkPassword, isValidTimeZone, normalizeGmail } from '@app/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { toAccount, type UserRow } from '../lib/account.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { tx, type Tx } from '../lib/db.js';
import { emails } from '../lib/emails.js';
import { AppError, parse } from '../lib/errors.js';
import { sendSafely } from '../lib/mailer.js';
import { burnPasswordCheck, hashPassword, needsRehash, verifyPassword } from '../lib/passwords.js';
import type { Deps } from '../app.js';

export const REFRESH_IDLE_DAYS = 30;
export const REFRESH_ABSOLUTE_DAYS = 180;
const VERIFY_TTL_HOURS = 24;
const RESET_TTL_MINUTES = 30;

// Login throttling (counted in the database so it holds across processes and restarts).
export const LOGIN_LIMITS = { perAccount15m: 5, perIp1h: 50, lockAfter: 20, lockMinutes: 60 };

const emailField = z.string().trim().min(3).max(254);
const passwordField = z.string().min(1).max(1024);

export function assertStrongPassword(password: string, email?: string) {
  const problem = checkPassword(password, email);
  if (problem) throw new AppError(400, 'weak_password', PASSWORD_PROBLEM_TEXT[problem], { problem });
}

async function issueToken(c: Tx, userId: string, purpose: string, ttlMinutes: number, ip: string): Promise<string> {
  // Only the newest link of each kind stays valid.
  await c.query(`UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [userId, purpose]);
  const token = randomToken();
  await c.query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, created_ip, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
    [userId, purpose, sha256(token), ip, ttlMinutes],
  );
  return token;
}

async function recentTokenCount(c: Tx, userId: string, purpose: string, minutes: number): Promise<number> {
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM auth_tokens WHERE user_id = $1 AND purpose = $2 AND created_at > now() - make_interval(mins => $3)`,
    [userId, purpose, minutes],
  );
  return rows[0]?.n ?? 0;
}

/** Consumes a single-use token. Returns its user id, or null if invalid/expired/used. */
export async function consumeToken(c: Tx, token: string, purpose: string): Promise<string | null> {
  const { rows } = await c.query<{ user_id: string }>(
    `UPDATE auth_tokens SET used_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [sha256(token), purpose],
  );
  return rows[0]?.user_id ?? null;
}

export async function adminNotifyAddress(c: Tx): Promise<string | null> {
  const { rows } = await c.query<{ email: string | null }>(
    `SELECT coalesce(s.admin_notify_email, (SELECT email_display FROM users WHERE role = 'admin')) AS email
       FROM platform_settings s`,
  );
  return rows[0]?.email ?? null;
}

export async function createSession(
  c: Tx,
  userId: string,
  kind: 'mobile' | 'web',
  device: { platform: string; name?: string | null; appVersion?: string | null },
  req: FastifyRequest,
): Promise<{ sessionId: string; refreshToken: string }> {
  const { rows: d } = await c.query<{ id: string }>(
    `INSERT INTO devices (user_id, platform, name, app_version) VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, device.platform, device.name ?? null, device.appVersion ?? null],
  );
  const refreshToken = randomToken();
  const { rows: s } = await c.query<{ id: string }>(
    `INSERT INTO sessions (user_id, device_id, kind, family_id, refresh_token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8)) RETURNING id`,
    [userId, d[0]!.id, kind, randomUUID(), sha256(refreshToken), req.ip,
     (req.headers['user-agent'] ?? '').slice(0, 300), REFRESH_IDLE_DAYS],
  );
  return { sessionId: s[0]!.id, refreshToken };
}

export async function resetPassword(deps: Deps, token: string, newPassword: string, ip: string): Promise<void> {
  const email = await tx(deps.db.auth, async (c) => {
    // Peek first so a weak password does not burn the token.
    const { rows: peek } = await c.query<{ email_display: string }>(
      `SELECT u.email_display FROM auth_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND t.purpose = 'password_reset' AND t.used_at IS NULL AND t.expires_at > now()
          AND u.role = 'user' AND u.status <> 'deleting'`,
      [sha256(token)],
    );
    if (!peek[0]) throw new AppError(400, 'invalid_token', 'This link is invalid or has expired. Request a new one.');
    assertStrongPassword(newPassword, peek[0].email_display);
    const userId = await consumeToken(c, token, 'password_reset');
    if (!userId) throw new AppError(400, 'invalid_token', 'This link is invalid or has expired. Request a new one.');
    // Receiving the reset email also proves ownership of the address.
    await c.query(
      `UPDATE users SET password_hash = $2, password_changed_at = now(), failed_login_count = 0, locked_until = NULL,
              email_verified_at = coalesce(email_verified_at, now())
        WHERE id = $1`,
      [userId, await hashPassword(newPassword)],
    );
    await c.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_reset' WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    await audit(c, { actorType: 'user', actorUserId: userId, action: 'user.password_reset', targetType: 'user', targetId: userId, targetUserId: userId, ip });
    return peek[0].email_display;
  });
  await sendSafely(deps.mailer, emails.passwordChanged(email), (m) => console.warn(m));
}

export async function verifyEmail(deps: Deps, token: string, ip: string): Promise<void> {
  const notify = await tx(deps.db.auth, async (c) => {
    const userId = await consumeToken(c, token, 'email_verify');
    if (!userId) throw new AppError(400, 'invalid_token', 'This link is invalid or has expired. Sign in to request a new one.');
    const { rows } = await c.query<{ email_display: string; was: Date | null }>(
      `UPDATE users u SET email_verified_at = coalesce(u.email_verified_at, now())
         FROM (SELECT id, email_verified_at AS was FROM users WHERE id = $1) old
        WHERE u.id = old.id RETURNING u.email_display, old.was`,
      [userId],
    );
    await audit(c, { actorType: 'user', actorUserId: userId, action: 'user.email_verified', targetType: 'user', targetId: userId, targetUserId: userId, ip });
    if (!rows[0] || rows[0].was) return null;
    const to = await adminNotifyAddress(c);
    return to ? { to, email: rows[0].email_display } : null;
  });
  if (notify) {
    await sendSafely(deps.mailer, emails.adminNewRegistration(notify.to, notify.email, deps.cfg.adminWebUrl), (m) => console.warn(m));
  }
}

export function registerAuthRoutes(app: FastifyInstance, deps: Deps) {
  const { cfg, db, mailer, signer } = deps;
  const warn = (m: string) => app.log.warn(m);
  const tight = { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } };

  // -------------------------------------------------------------------------
  app.post('/v1/auth/register', tight, async (req, reply) => {
    const body = parse(z.object({ email: emailField, password: passwordField, timezone: z.string().max(64).optional() }), req.body);
    const g = normalizeGmail(body.email);
    if (!g.ok) {
      throw new AppError(400, 'validation_failed',
        g.reason === 'not_gmail' ? 'Please register with a Gmail address (@gmail.com).' : 'Enter a valid email address.');
    }
    assertStrongPassword(body.password, g.display);
    const timezone = body.timezone && isValidTimeZone(body.timezone) ? body.timezone : 'UTC';
    const hash = await hashPassword(body.password);

    const mail = await tx(db.auth, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO users (email_normalized, email_display, password_hash, timezone)
         VALUES ($1, $2, $3, $4) ON CONFLICT (email_normalized) DO NOTHING RETURNING id`,
        [g.normalized, g.display, hash, timezone],
      );
      if (rows[0]) {
        const token = await issueToken(c, rows[0].id, 'email_verify', VERIFY_TTL_HOURS * 60, req.ip);
        await audit(c, { actorType: 'user', actorUserId: rows[0].id, action: 'user.registered', targetType: 'user', targetId: rows[0].id, targetUserId: rows[0].id, ip: req.ip });
        return emails.verify(g.display, `${cfg.publicApiUrl}/v1/pages/verify-email?token=${token}`);
      }
      // Address already registered: same response to the caller, but tell the real owner by email.
      const { rows: ex } = await c.query<{ id: string; email_display: string; email_verified_at: Date | null; role: string; status: string }>(
        `SELECT id, email_display, email_verified_at, role, status FROM users WHERE email_normalized = $1`, [g.normalized]);
      const u = ex[0];
      if (!u || u.role !== 'user' || u.status === 'deleting') return null;
      if (!u.email_verified_at) {
        if ((await recentTokenCount(c, u.id, 'email_verify', 2)) > 0) return null;
        const token = await issueToken(c, u.id, 'email_verify', VERIFY_TTL_HOURS * 60, req.ip);
        return emails.verify(u.email_display, `${cfg.publicApiUrl}/v1/pages/verify-email?token=${token}`);
      }
      if ((await recentTokenCount(c, u.id, 'password_reset', 60)) >= 3) return null;
      const token = await issueToken(c, u.id, 'password_reset', RESET_TTL_MINUTES, req.ip);
      return emails.alreadyRegistered(u.email_display, `${cfg.publicApiUrl}/v1/pages/reset-password?token=${token}`);
    });
    if (mail) await sendSafely(mailer, mail, warn);
    return reply.code(202).send({ message: 'Check your Gmail inbox for a confirmation link.' });
  });

  // -------------------------------------------------------------------------
  app.post('/v1/auth/resend-verification', tight, async (req, reply) => {
    const body = parse(z.object({ email: emailField }), req.body);
    const g = normalizeGmail(body.email);
    if (g.ok) {
      const mail = await tx(db.auth, async (c) => {
        const { rows } = await c.query<{ id: string; email_display: string }>(
          `SELECT id, email_display FROM users WHERE email_normalized = $1 AND role = 'user'
              AND email_verified_at IS NULL AND status = 'pending'`, [g.normalized]);
        const u = rows[0];
        if (!u || (await recentTokenCount(c, u.id, 'email_verify', 2)) > 0) return null;
        const token = await issueToken(c, u.id, 'email_verify', VERIFY_TTL_HOURS * 60, req.ip);
        return emails.verify(u.email_display, `${cfg.publicApiUrl}/v1/pages/verify-email?token=${token}`);
      });
      if (mail) await sendSafely(mailer, mail, warn);
    }
    return reply.code(202).send({ message: 'If that address is waiting for confirmation, a new link has been sent.' });
  });

  app.post('/v1/auth/verify-email', tight, async (req) => {
    const body = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
    await verifyEmail(deps, body.token, req.ip);
    return { message: 'Email confirmed. Your account is waiting for administrator approval.' };
  });

  // -------------------------------------------------------------------------
  app.post('/v1/auth/login', { config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } }, async (req) => {
    const body = parse(z.object({
      email: emailField,
      password: passwordField,
      device: z.object({
        platform: z.enum(['android', 'ios', 'web']),
        name: z.string().max(100).optional(),
        appVersion: z.string().max(40).optional(),
      }),
    }), req.body);
    const g = normalizeGmail(body.email);
    const normalized = g.ok ? g.normalized : body.email.trim().toLowerCase();

    const fail = async (c: Tx | null, userId: string | null, reason: string) => {
      const run = async (cc: Tx) => cc.query(
        `INSERT INTO login_attempts (email_normalized, user_id, ip, surface, success, failure_reason) VALUES ($1, $2, $3, 'app', false, $4)`,
        [normalized, userId, req.ip, reason]);
      if (c) await run(c); else await tx(db.auth, run);
    };

    const { rows: counts } = await db.auth.query<{ acct: number; ip: number }>(
      `SELECT count(*) FILTER (WHERE email_normalized = $1 AND created_at > now() - interval '15 minutes')::int AS acct,
              count(*) FILTER (WHERE ip = $2 AND created_at > now() - interval '1 hour')::int AS ip
         FROM login_attempts WHERE NOT success AND (email_normalized = $1 OR ip = $2) AND created_at > now() - interval '1 hour'`,
      [normalized, req.ip]);
    if ((counts[0]?.acct ?? 0) >= LOGIN_LIMITS.perAccount15m || (counts[0]?.ip ?? 0) >= LOGIN_LIMITS.perIp1h) {
      throw new AppError(429, 'too_many_attempts', 'Too many failed sign-in attempts. Try again in 15 minutes.', undefined, { 'retry-after': '900' });
    }

    const { rows } = await db.auth.query<UserRow>(`SELECT * FROM users WHERE email_normalized = $1`, [normalized]);
    const user = rows[0];
    if (!user || user.role !== 'user' || user.status === 'deleting') {
      await burnPasswordCheck(body.password);
      await fail(null, null, 'unknown_account');
      throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect.');
    }
    if (user.locked_until && user.locked_until > new Date()) {
      await burnPasswordCheck(body.password);
      throw new AppError(429, 'too_many_attempts', 'This account is temporarily locked after repeated failed sign-ins. Try again later or reset your password.');
    }
    if (!(await verifyPassword(user.password_hash, body.password))) {
      await tx(db.auth, async (c) => {
        await c.query(
          `UPDATE users SET failed_login_count = failed_login_count + 1,
                  locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
            WHERE id = $1`, [user.id, LOGIN_LIMITS.lockAfter, LOGIN_LIMITS.lockMinutes]);
        await fail(c, user.id, 'bad_password');
      });
      throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect.');
    }
    if (!user.email_verified_at) {
      throw new AppError(403, 'email_not_verified', 'Please confirm your email address first. Check your Gmail inbox, or request a new link.');
    }
    if (user.status === 'rejected') {
      throw new AppError(403, 'account_rejected', 'Your registration was not approved. Contact the administrator.');
    }

    const rehash = needsRehash(user.password_hash) ? await hashPassword(body.password) : null;
    const session = await tx(db.auth, async (c) => {
      await c.query(
        `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now(),
                password_hash = coalesce($2, password_hash) WHERE id = $1`, [user.id, rehash]);
      await c.query(
        `INSERT INTO login_attempts (email_normalized, user_id, ip, surface, success) VALUES ($1, $2, $3, 'app', true)`,
        [normalized, user.id, req.ip]);
      return createSession(c, user.id, body.device.platform === 'web' ? 'web' : 'mobile', body.device, req);
    });
    const access = await signer.signAccess({ sub: user.id, sid: session.sessionId });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: session.refreshToken,
      account: toAccount(user),
    };
  });

  // -------------------------------------------------------------------------
  app.post('/v1/auth/refresh', { config: { rateLimit: { max: 60, timeWindow: '15 minutes' } } }, async (req) => {
    const body = parse(z.object({ refreshToken: z.string().min(20).max(200) }), req.body);
    const hash = sha256(body.refreshToken);
    const newToken = randomToken();
    const result = await tx(db.auth, async (c) => {
      const { rows } = await c.query<{ id: string; user_id: string }>(
        `UPDATE sessions SET previous_token_hash = refresh_token_hash, refresh_token_hash = $2, last_used_at = now(),
                expires_at = least(created_at + make_interval(days => $3), now() + make_interval(days => $4))
          WHERE refresh_token_hash = $1 AND revoked_at IS NULL AND expires_at > now() AND kind <> 'admin'
          RETURNING id, user_id`,
        [hash, sha256(newToken), REFRESH_ABSOLUTE_DAYS, REFRESH_IDLE_DAYS]);
      if (rows[0]) return { ok: true as const, ...rows[0] };
      // An already-rotated token was presented again: assume it was stolen and end the whole session family.
      const { rows: reused } = await c.query<{ family_id: string; user_id: string }>(
        `SELECT family_id, user_id FROM sessions WHERE previous_token_hash = $1`, [hash]);
      if (reused[0]) {
        await c.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'refresh_token_reuse'
                        WHERE family_id = $1 AND revoked_at IS NULL`, [reused[0].family_id]);
        await audit(c, { actorType: 'system', action: 'session.refresh_reuse_detected', targetType: 'user',
          targetId: reused[0].user_id, targetUserId: reused[0].user_id, ip: req.ip });
      }
      return { ok: false as const };
    });
    if (!result.ok) throw new AppError(401, 'session_revoked', 'Your session has ended. Please sign in again.');

    const { rows } = await db.auth.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [result.user_id]);
    const user = rows[0];
    if (!user || user.status === 'deleting' || user.status === 'rejected') {
      throw new AppError(401, 'session_revoked', 'Your session has ended. Please sign in again.');
    }
    const access = await signer.signAccess({ sub: user.id, sid: result.id });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: newToken,
      account: toAccount(user),
    };
  });

  // -------------------------------------------------------------------------
  app.post('/v1/auth/password-reset/request', tight, async (req, reply) => {
    const body = parse(z.object({ email: emailField }), req.body);
    const g = normalizeGmail(body.email);
    if (g.ok) {
      const mail = await tx(db.auth, async (c) => {
        const { rows } = await c.query<{ id: string; email_display: string }>(
          `SELECT id, email_display FROM users WHERE email_normalized = $1 AND role = 'user' AND status NOT IN ('deleting')`,
          [g.normalized]);
        const u = rows[0];
        if (!u || (await recentTokenCount(c, u.id, 'password_reset', 60)) >= 3) return null;
        const token = await issueToken(c, u.id, 'password_reset', RESET_TTL_MINUTES, req.ip);
        return emails.passwordReset(u.email_display, `${cfg.publicApiUrl}/v1/pages/reset-password?token=${token}`);
      });
      if (mail) await sendSafely(mailer, mail, warn);
    }
    return reply.code(202).send({ message: 'If an account exists for that address, a reset link has been sent to it.' });
  });

  app.post('/v1/auth/password-reset/confirm', tight, async (req) => {
    const body = parse(z.object({ token: z.string().min(10).max(200), newPassword: passwordField }), req.body);
    await resetPassword(deps, body.token, body.newPassword, req.ip);
    return { message: 'Password changed. Sign in with your new password.' };
  });
}
