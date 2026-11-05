import { isValidTimeZone, type SessionInfo } from '@app/shared';
import { activationCodeHash, normalizeActivationCode } from '../lib/activation.js';
import { WEB_REFRESH_COOKIE } from './auth.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { iso, toAccount, type UserRow } from '../lib/account.js';
import { audit } from '../lib/audit.js';
import { withUser } from '../lib/db.js';
import { emails } from '../lib/emails.js';
import { AppError, parse } from '../lib/errors.js';
import { sendSafely } from '../lib/mailer.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import type { Deps } from '../app.js';
import { assertStrongPassword } from './auth.js';

export function registerMeRoutes(app: FastifyInstance, deps: Deps) {
  const { db, mailer } = deps;
  const authed = { preHandler: app.authenticate };
  const active = { preHandler: [app.authenticate, app.requireActive] };

  /** Available in every account state so the app can show pending / suspended / expired screens. */
  app.get('/v1/me', authed, async (req) => {
    const user = req.auth!.user;
    const periods = await withUser(db.api, user.id, (c) =>
      c.query<{ kind: string; starts_at: Date; ends_at: Date }>(
        `SELECT kind, starts_at, ends_at FROM access_periods ORDER BY starts_at DESC LIMIT 12`));
    return {
      account: toAccount(user),
      accessPeriods: periods.rows.map((p) => ({ kind: p.kind, startsAt: iso(p.starts_at), endsAt: iso(p.ends_at) })),
    };
  });

  app.patch('/v1/me', authed, async (req) => {
    const body = parse(z.object({ timezone: z.string().max(64) }), req.body);
    if (!isValidTimeZone(body.timezone)) throw new AppError(400, 'validation_failed', 'Unknown time zone.');
    const { rows } = await withUser(db.api, req.auth!.user.id, (c) =>
      c.query<UserRow>(`UPDATE users SET timezone = $1 WHERE id = app.current_user_id() RETURNING *`, [body.timezone]));
    return { account: toAccount(rows[0]!) };
  });

  app.post('/v1/me/password', { ...authed, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req) => {
    const body = parse(z.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(1).max(1024) }), req.body);
    const user = req.auth!.user;
    if (!(await verifyPassword(user.password_hash, body.currentPassword))) {
      throw new AppError(400, 'invalid_credentials', 'Your current password is incorrect.');
    }
    assertStrongPassword(body.newPassword, user.email_display);
    const hash = await hashPassword(body.newPassword);
    await withUser(db.api, user.id, async (c) => {
      await c.query(`UPDATE users SET password_hash = $1, password_changed_at = now() WHERE id = app.current_user_id()`, [hash]);
      await c.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_changed'
                      WHERE revoked_at IS NULL AND id <> $1`, [req.auth!.sessionId]);
      await audit(c, { actorType: 'user', actorUserId: user.id, action: 'user.password_changed', targetType: 'user', targetId: user.id, targetUserId: user.id, ip: req.ip });
    });
    await sendSafely(mailer, emails.passwordChanged(user.email_display), (m) => app.log.warn(m));
    return { message: 'Password changed. Other devices have been signed out.' };
  });

  app.get('/v1/me/sessions', authed, async (req) => {
    const { rows } = await withUser(db.api, req.auth!.user.id, (c) =>
      c.query<{ id: string; name: string | null; platform: string | null; created_at: Date; last_used_at: Date; ip: string | null }>(
        `SELECT s.id, d.name, d.platform, s.created_at, s.last_used_at, host(s.ip) AS ip
           FROM sessions s LEFT JOIN devices d ON d.id = s.device_id
          WHERE s.revoked_at IS NULL AND s.expires_at > now()
          ORDER BY s.last_used_at DESC`));
    const sessions: SessionInfo[] = rows.map((r) => ({
      id: r.id, current: r.id === req.auth!.sessionId, deviceName: r.name, platform: r.platform,
      createdAt: r.created_at.toISOString(), lastUsedAt: r.last_used_at.toISOString(), ip: r.ip,
    }));
    return { sessions };
  });

  app.delete('/v1/me/sessions/:id', authed, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { rowCount } = await withUser(db.api, req.auth!.user.id, async (c) => {
      const r = await c.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'revoked_by_user' WHERE id = $1 AND revoked_at IS NULL`, [id]);
      await c.query(`UPDATE devices SET revoked_at = now() WHERE id = (SELECT device_id FROM sessions WHERE id = $1)`, [id]);
      return r;
    });
    // RLS makes another user's session invisible, so it is indistinguishable from a missing one.
    if (!rowCount) throw new AppError(404, 'not_found', 'Session not found.');
    return reply.code(204).send();
  });

  /** Activates (or renews) the signed-in account with a code from the administrator. One code, one account, once. */
  app.post('/v1/me/activation-code', { ...authed, config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req) => {
    const body = parse(z.object({ code: z.string().trim().min(1).max(64) }), req.body);
    const norm = normalizeActivationCode(body.code);
    const uid = req.auth!.user.id;
    const r = await withUser(db.api, uid, async (c) => {
      // A malformed code still counts as a failed attempt.
      const { rows } = await c.query<{ result: string; ends_at: Date | null; previous_status: string }>(
        `SELECT * FROM app.redeem_activation_code($1)`, [activationCodeHash(norm ?? `invalid:${body.code}`)]);
      const row = rows[0]!;
      if (row.result === 'ok') {
        await audit(c, { actorType: 'user', actorUserId: uid, action: 'account.activated_with_code', targetType: 'user', targetId: uid, targetUserId: uid, ip: req.ip,
          details: { previous_status: row.previous_status, ends_at: row.ends_at } });
      }
      return row;
    });
    const messages: Record<string, [number, string, string]> = {
      invalid: [400, 'invalid_token', 'That code is not valid. Check it and try again.'],
      used: [409, 'conflict', 'This code has already been used. Each code works for one account only.'],
      revoked: [409, 'conflict', 'This code has been cancelled. Ask the administrator for a new one.'],
      expired: [409, 'conflict', 'This code has expired. Ask the administrator for a new one.'],
      wrong_account: [409, 'conflict', 'This code was issued for a different account.'],
      email_not_verified: [403, 'email_not_verified', 'Confirm your email address first (check your Gmail inbox), then enter the code.'],
      not_eligible: [403, 'account_suspended', 'This account cannot be activated with a code. Contact the administrator.'],
      too_many_attempts: [429, 'too_many_attempts', 'Too many wrong codes. Wait 15 minutes and try again.'],
    };
    if (r.result !== 'ok') {
      const [status, code, message] = messages[r.result] ?? messages.invalid!;
      throw new AppError(status, code as never, message);
    }
    const { rows } = await withUser(db.api, uid, (c) => c.query<UserRow>(`SELECT * FROM users WHERE id = app.current_user_id()`));
    return { account: toAccount(rows[0]!), accessExpiresAt: r.ends_at!.toISOString() };
  });

  app.post('/v1/auth/logout', authed, async (req, reply) => {
    await withUser(db.api, req.auth!.user.id, async (c) => {
      await c.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1`, [req.auth!.sessionId]);
      await c.query(`UPDATE devices SET revoked_at = now() WHERE id = (SELECT device_id FROM sessions WHERE id = $1)`, [req.auth!.sessionId]);
    });
    reply.clearCookie(WEB_REFRESH_COOKIE, { path: '/v1/auth' });
    return reply.code(204).send();
  });

  /** Placeholder for the main application. Mailbox routes (Milestone 2) use the same `active` guard. */
  app.get('/v1/app/home', active, async (req) => {
    const user = req.auth!.user;
    return { account: toAccount(user), mailboxes: [] as unknown[] };
  });
}
