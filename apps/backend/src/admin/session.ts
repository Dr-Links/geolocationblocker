import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Config } from '../lib/config.js';
import { randomToken, safeEqual, sha256 } from '../lib/crypto.js';
import type { Db, Tx } from '../lib/db.js';
import { AppError } from '../lib/errors.js';

export const ADMIN_IDLE_MINUTES = 30;
export const ADMIN_ABSOLUTE_HOURS = 8;
export const ADMIN_PRE_MFA_MINUTES = 5;

export function cookieNames(cfg: Config) {
  // __Host- cookies require HTTPS; plain names are used for local http development.
  return cfg.cookieSecure
    ? { session: '__Host-adm_session', csrf: '__Host-adm_csrf' }
    : { session: 'adm_session', csrf: 'adm_csrf' };
}

export async function startAdminSession(c: Tx, req: FastifyRequest, userId: string, mfaVerified: boolean): Promise<string> {
  const token = randomToken();
  await c.query(
    `INSERT INTO sessions (user_id, kind, family_id, refresh_token_hash, ip, user_agent, mfa_verified_at, expires_at)
     VALUES ($1, 'admin', $2, $3, $4, $5, CASE WHEN $6 THEN now() END,
             now() + CASE WHEN $6 THEN make_interval(hours => $7) ELSE make_interval(mins => $8) END)`,
    [userId, randomUUID(), sha256(token), req.ip, (req.headers['user-agent'] ?? '').slice(0, 300),
     mfaVerified, ADMIN_ABSOLUTE_HOURS, ADMIN_PRE_MFA_MINUTES],
  );
  return token;
}

export function setSessionCookies(reply: FastifyReply, cfg: Config, token: string, withCsrf: boolean) {
  const names = cookieNames(cfg);
  const base = { path: '/', secure: cfg.cookieSecure, sameSite: 'strict' as const };
  reply.setCookie(names.session, token, { ...base, httpOnly: true, maxAge: ADMIN_ABSOLUTE_HOURS * 3600 });
  if (withCsrf) reply.setCookie(names.csrf, randomToken(18), { ...base, httpOnly: false, maxAge: ADMIN_ABSOLUTE_HOURS * 3600 });
}

export function clearSessionCookies(reply: FastifyReply, cfg: Config) {
  const names = cookieNames(cfg);
  reply.clearCookie(names.session, { path: '/' });
  reply.clearCookie(names.csrf, { path: '/' });
}

export interface AdminSession {
  sessionId: string;
  userId: string;
  email: string;
  mfaVerified: boolean;
}

export async function loadAdminSession(db: Db, cfg: Config, req: FastifyRequest): Promise<AdminSession | null> {
  const token = req.cookies[cookieNames(cfg).session];
  if (!token) return null;
  const { rows } = await db.query<{ id: string; user_id: string; mfa_verified_at: Date | null; email_display: string }>(
    `UPDATE sessions s SET last_used_at = now()
       FROM users u
      WHERE s.refresh_token_hash = $1 AND s.kind = 'admin' AND s.revoked_at IS NULL AND s.expires_at > now()
        AND s.last_used_at > now() - make_interval(mins => $2)
        AND u.id = s.user_id AND u.role = 'admin'
      RETURNING s.id, s.user_id, s.mfa_verified_at, u.email_display`,
    [sha256(token), ADMIN_IDLE_MINUTES]);
  const r = rows[0];
  return r ? { sessionId: r.id, userId: r.user_id, email: r.email_display, mfaVerified: r.mfa_verified_at !== null } : null;
}

/** Double-submit CSRF token + Origin check for every state-changing admin request. */
export function checkCsrf(cfg: Config, req: FastifyRequest) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.origin;
  if (origin && origin !== new URL(cfg.adminWebUrl).origin) throw new AppError(403, 'csrf_failed', 'Request origin not allowed.');
  const cookie = req.cookies[cookieNames(cfg).csrf];
  const header = req.headers['x-csrf-token'];
  if (!cookie || typeof header !== 'string' || !safeEqual(cookie, header)) {
    throw new AppError(403, 'csrf_failed', 'Security token missing or invalid. Reload the page.');
  }
}
