import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildAdminApi } from '../src/admin/app.js';
import { enrollMfa } from '../src/admin/mfa.js';
import { buildUserApi } from '../src/app.js';
import { loadConfig, type Config } from '../src/lib/config.js';
import { createPool, tx, type Db } from '../src/lib/db.js';
import { TokenSigner } from '../src/lib/jwt.js';
import { MemoryMailer } from '../src/lib/mailer.js';
import { hashPassword } from '../src/lib/passwords.js';
import { testEnv } from './env.js';

export const PASSWORD = 'correct horse battery';
export const ADMIN_EMAIL = 'owner@example.org';
export const ADMIN_PASSWORD = 'a very long admin passphrase';

export interface Ctx {
  cfg: Config;
  owner: Db;
  pools: Db[];
  mailer: MemoryMailer;
  api: FastifyInstance;
  admin: FastifyInstance;
  close(): Promise<void>;
}

export async function makeCtx(): Promise<Ctx> {
  const cfg = loadConfig(testEnv());
  const mailer = new MemoryMailer();
  const owner = createPool(cfg, 'owner', 2);
  const auth = createPool(cfg, 'auth');
  const apiPool = createPool(cfg, 'api');
  const adminPool = createPool(cfg, 'admin');
  const api = await buildUserApi({ cfg, db: { auth, api: apiPool }, mailer, signer: await TokenSigner.create() });
  const admin = await buildAdminApi({ cfg, db: adminPool, mailer });
  const pools = [owner, auth, apiPool, adminPool];
  return {
    cfg, owner, pools, mailer, api, admin,
    async close() {
      await api.close();
      await admin.close();
      await Promise.all(pools.map((p) => p.end()));
    },
  };
}

/** Removes all rows between test files (owner bypasses RLS). */
export async function resetData(ctx: Ctx) {
  await ctx.owner.query(`TRUNCATE app.users, app.audit_log, app.login_attempts, app.deletion_requests CASCADE`);
  ctx.mailer.sent.length = 0;
}

export function tokenFromMail(text: string): string {
  const m = text.match(/token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`no token in mail: ${text}`);
  return m[1]!;
}

export async function registerVerified(ctx: Ctx, email: string, timezone = 'UTC') {
  const r = await ctx.api.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: PASSWORD, timezone } });
  if (r.statusCode !== 202) throw new Error(`register failed ${r.statusCode} ${r.body}`);
  const mail = ctx.mailer.lastTo(email.toLowerCase());
  const v = await ctx.api.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token: tokenFromMail(mail!.text) } });
  if (v.statusCode !== 200) throw new Error(`verify failed ${v.body}`);
  const { rows } = await ctx.owner.query<{ id: string }>(`SELECT id FROM app.users WHERE email_display = $1`, [email.toLowerCase()]);
  return rows[0]!.id;
}

export async function login(ctx: Ctx, email: string, password = PASSWORD) {
  const r = await ctx.api.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password, device: { platform: 'android', name: 'Test phone' } } });
  return { status: r.statusCode, body: r.json() as any };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export async function createAdmin(ctx: Ctx): Promise<{ id: string; secret: string; recoveryCodes: string[] }> {
  return tx(ctx.owner, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.users (email_normalized, email_display, password_hash, role, status, email_verified_at, access_expires_at)
       VALUES ($1, $1, $2, 'admin', 'approved', now(), 'infinity') RETURNING id`, [ADMIN_EMAIL, await hashPassword(ADMIN_PASSWORD)]);
    const e = await enrollMfa(c, ctx.cfg, rows[0]!.id, ADMIN_EMAIL);
    return { id: rows[0]!.id, secret: e.secret, recoveryCodes: e.recoveryCodes };
  });
}

/** TOTP code for the current step + offset (each code can be used only once). */
export function totpCode(secret: string, offsetSteps = 0): string {
  const t = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
  return t.generate({ timestamp: Date.now() + offsetSteps * 30_000 });
}

export interface InjectResult {
  statusCode: number;
  body: string;
  json(): any;
  cookies: Array<{ name: string; value: string }>;
}

export interface AdminClient {
  get(url: string): Promise<InjectResult>;
  post(url: string, payload?: unknown): Promise<InjectResult>;
  patch(url: string, payload?: unknown): Promise<InjectResult>;
}

function cookieJar(res: { cookies: Array<{ name: string; value: string }> }, jar: Record<string, string>) {
  for (const c of res.cookies) jar[c.name] = c.value;
}

export async function adminLogin(ctx: Ctx, secret: string, offset = 0): Promise<AdminClient> {
  const jar: Record<string, string> = {};
  const r1 = await ctx.admin.inject({ method: 'POST', url: '/admin/api/auth/login', payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  if (r1.statusCode !== 200) throw new Error(`admin login ${r1.statusCode} ${r1.body}`);
  cookieJar(r1, jar);
  const r2 = await ctx.admin.inject({ method: 'POST', url: '/admin/api/auth/mfa', cookies: jar, payload: { code: totpCode(secret, offset) } });
  if (r2.statusCode !== 200) throw new Error(`admin mfa ${r2.statusCode} ${r2.body}`);
  cookieJar(r2, jar);
  const headers = () => ({ 'x-csrf-token': jar.adm_csrf!, origin: 'http://admin.test' });
  return {
    get: (url) => ctx.admin.inject({ method: 'GET', url, cookies: jar }),
    post: (url, payload) => ctx.admin.inject({ method: 'POST', url, cookies: jar, headers: headers(), payload: (payload ?? {}) as object }),
    patch: (url, payload) => ctx.admin.inject({ method: 'PATCH', url, cookies: jar, headers: headers(), payload: (payload ?? {}) as object }),
  };
}
