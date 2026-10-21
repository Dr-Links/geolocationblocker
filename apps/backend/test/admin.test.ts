import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, type Db } from '../src/lib/db.js';
import { MemoryMailer } from '../src/lib/mailer.js';
import { schedulerTick } from '../src/scheduler.js';
import {
  ADMIN_EMAIL, ADMIN_PASSWORD, adminLogin, bearer, createAdmin, login, makeCtx, registerVerified, resetData, tokenFromMail, totpCode, type Ctx,
} from './helpers.js';

let ctx: Ctx;
let worker: Db;
let adminSecret: string;
let recovery: string[];
beforeAll(async () => {
  ctx = await makeCtx();
  worker = createPool(ctx.cfg, 'worker');
});
afterAll(async () => {
  await worker.end();
  await ctx.close();
});
beforeEach(async () => {
  await resetData(ctx);
  const a = await createAdmin(ctx);
  adminSecret = a.secret;
  recovery = a.recoveryCodes;
});

describe('admin authentication', () => {
  it('requires password AND authenticator code', async () => {
    const bad = await ctx.admin.inject({ method: 'POST', url: '/admin/api/auth/login', payload: { email: ADMIN_EMAIL, password: 'wrong wrong wrong' } });
    expect(bad.statusCode).toBe(401);
    const r1 = await ctx.admin.inject({ method: 'POST', url: '/admin/api/auth/login', payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    expect(r1.json()).toEqual({ mfaRequired: true });
    const jar = Object.fromEntries(r1.cookies.map((c) => [c.name, c.value]));
    // Pre-MFA session cannot use the dashboard.
    const early = await ctx.admin.inject({ method: 'GET', url: '/admin/api/dashboard', cookies: jar });
    expect(early.json().error.code).toBe('mfa_required');
    const wrong = await ctx.admin.inject({ method: 'POST', url: '/admin/api/auth/mfa', cookies: jar, payload: { code: '000000' } });
    expect(wrong.statusCode).toBe(401);
    const ok = await ctx.admin.inject({ method: 'POST', url: '/admin/api/auth/mfa', cookies: jar, payload: { code: totpCode(adminSecret) } });
    expect(ok.statusCode).toBe(200);
    // Session id is rotated after MFA: the pre-MFA cookie is now dead.
    const stale = await ctx.admin.inject({ method: 'GET', url: '/admin/api/dashboard', cookies: jar });
    expect(stale.statusCode).toBe(401);
  });

  it('rejects a reused TOTP code and accepts a recovery code once', async () => {
    const code = totpCode(adminSecret);
    await adminLogin(ctx, adminSecret);
    const r1 = await ctx.admin.inject({ method: 'POST', url: '/admin/api/auth/login', payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    const jar = Object.fromEntries(r1.cookies.map((c) => [c.name, c.value]));
    const replay = await ctx.admin.inject({ method: 'POST', url: '/admin/api/auth/mfa', cookies: jar, payload: { code } });
    expect(replay.statusCode).toBe(401);
    const rc = await ctx.admin.inject({ method: 'POST', url: '/admin/api/auth/mfa', cookies: jar, payload: { recoveryCode: recovery[0] } });
    expect(rc.statusCode).toBe(200);
  });

  it('enforces CSRF on state-changing requests and rejects user tokens', async () => {
    const admin = await adminLogin(ctx, adminSecret);
    const id = await registerVerified(ctx, 'mia@gmail.com');
    const noCsrf = await ctx.admin.inject({ method: 'POST', url: `/admin/api/users/${id}/approve`, payload: {},
      cookies: Object.fromEntries((await admin.get('/admin/api/me')).cookies.map((c) => [c.name, c.value])) });
    expect(noCsrf.statusCode).toBe(401); // no session cookie passed at all here
    const l = await login(ctx, 'mia@gmail.com');
    const userToken = await ctx.admin.inject({ method: 'GET', url: '/admin/api/dashboard', headers: bearer(l.body.accessToken) });
    expect(userToken.statusCode).toBe(401);
    const userOnAdminLogin = await ctx.admin.inject({ method: 'POST', url: '/admin/api/auth/login', payload: { email: 'mia@gmail.com', password: 'correct horse battery' } });
    expect(userOnAdminLogin.statusCode).toBe(401);
  });

  it('rejects requests with a missing CSRF header', async () => {
    const r1 = await ctx.admin.inject({ method: 'POST', url: '/admin/api/auth/login', payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    const jar: Record<string, string> = Object.fromEntries(r1.cookies.map((c) => [c.name, c.value]));
    const r2 = await ctx.admin.inject({ method: 'POST', url: '/admin/api/auth/mfa', cookies: jar, payload: { code: totpCode(adminSecret) } });
    for (const c of r2.cookies) jar[c.name] = c.value;
    const res = await ctx.admin.inject({ method: 'PATCH', url: '/admin/api/settings', cookies: jar, payload: { defaultTimezone: 'UTC' } });
    expect(res.json().error.code).toBe('csrf_failed');
    const evil = await ctx.admin.inject({ method: 'PATCH', url: '/admin/api/settings', cookies: jar,
      headers: { 'x-csrf-token': jar.adm_csrf!, origin: 'https://evil.example' }, payload: { defaultTimezone: 'UTC' } });
    expect(evil.json().error.code).toBe('csrf_failed');
  });
});

describe('account lifecycle', () => {
  it('approve -> access for one calendar month in the user\'s zone -> expiry suspends -> renew restores', async () => {
    const admin = await adminLogin(ctx, adminSecret);
    const id = await registerVerified(ctx, 'nia@gmail.com', 'Africa/Lagos');
    expect(ctx.mailer.sent.some((m) => m.to === ADMIN_EMAIL && /pending approval/.test(m.subject))).toBe(true);

    const l = await login(ctx, 'nia@gmail.com');
    const approve = await admin.post(`/admin/api/users/${id}/approve`, { paymentNote: 'Bank transfer #123' });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().timezone).toBe('Africa/Lagos');
    const { rows } = await ctx.owner.query<{ ok: boolean }>(
      `SELECT access_expires_at = app.add_calendar_month(approved_at, 'Africa/Lagos') AS ok FROM app.users WHERE id = $1`, [id]);
    expect(rows[0]!.ok).toBe(true);
    expect(ctx.mailer.lastTo('nia@gmail.com')!.subject).toMatch(/approved/);

    // Same token now works for the main app (status is checked per request).
    expect((await ctx.api.inject({ method: 'GET', url: '/v1/app/home', headers: bearer(l.body.accessToken) })).statusCode).toBe(200);

    // Time passes: access ends. Before the scheduler runs, requests are already refused.
    await ctx.owner.query(`UPDATE app.users SET access_expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
    const blocked = await ctx.api.inject({ method: 'GET', url: '/v1/app/home', headers: bearer(l.body.accessToken) });
    expect(blocked.json().error.code).toBe('account_expired');

    const wm = new MemoryMailer();
    const tick = await schedulerTick(worker, wm, () => undefined);
    expect(tick.expired).toBe(1);
    expect(wm.sent.map((m) => m.to).sort()).toEqual(['nia@gmail.com', ADMIN_EMAIL].sort());
    const { rows: st } = await ctx.owner.query(`SELECT status, suspension_reason FROM app.users WHERE id = $1`, [id]);
    expect(st[0]).toEqual({ status: 'suspended', suspension_reason: 'expired' });
    // Suspension revoked the session.
    expect((await ctx.api.inject({ method: 'GET', url: '/v1/me', headers: bearer(l.body.accessToken) })).statusCode).toBe(401);
    // A second tick does nothing (idempotent).
    expect((await schedulerTick(worker, wm, () => undefined)).expired).toBe(0);

    // User can still sign in and sees "expired" with data intact.
    const l2 = await login(ctx, 'nia@gmail.com');
    expect(l2.body.account.displayStatus).toBe('expired');

    // Long-lapsed account: extending from the old expiry would end in the past, so it is refused.
    await ctx.owner.query(`UPDATE app.users SET access_expires_at = now() - interval '40 days' WHERE id = $1`, [id]);
    const fromPrev = await admin.post(`/admin/api/users/${id}/renew`, { mode: 'from_current_expiry' });
    expect(fromPrev.statusCode).toBe(409);
    const renew = await admin.post(`/admin/api/users/${id}/renew`, { mode: 'from_now', paymentNote: 'Cash' });
    expect(renew.statusCode).toBe(200);
    const l3 = await login(ctx, 'nia@gmail.com');
    expect(l3.body.account.displayStatus).toBe('active');

    const detail = (await admin.get(`/admin/api/users/${id}`)).json();
    expect(detail.accessPeriods.map((p: { kind: string }) => p.kind)).toEqual(['reactivation', 'approval']);
    expect(detail.activity.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['user.approved', 'user.expired', 'user.reactivated']));
  });

  it('cannot approve an unverified registration', async () => {
    const admin = await adminLogin(ctx, adminSecret);
    await ctx.api.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'olu@gmail.com', password: 'correct horse battery' } });
    const { rows } = await ctx.owner.query<{ id: string }>(`SELECT id FROM app.users WHERE email_display = 'olu@gmail.com'`);
    const r = await admin.post(`/admin/api/users/${rows[0]!.id}/approve`);
    expect(r.statusCode).toBe(409);
  });

  it('admin suspension blocks immediately; reject blocks login', async () => {
    const admin = await adminLogin(ctx, adminSecret);
    const id = await registerVerified(ctx, 'pat@gmail.com');
    await admin.post(`/admin/api/users/${id}/approve`);
    const l = await login(ctx, 'pat@gmail.com');
    expect((await admin.post(`/admin/api/users/${id}/suspend`)).statusCode).toBe(200);
    expect((await ctx.api.inject({ method: 'GET', url: '/v1/app/home', headers: bearer(l.body.accessToken) })).statusCode).toBe(401);
    expect((await login(ctx, 'pat@gmail.com')).body.account.displayStatus).toBe('suspended');

    const id2 = await registerVerified(ctx, 'quinn@gmail.com');
    expect((await admin.post(`/admin/api/users/${id2}/reject`)).statusCode).toBe(200);
    expect((await login(ctx, 'quinn@gmail.com')).body.error.code).toBe('account_rejected');
  });

  it('sends expiry warnings once per level', async () => {
    const admin = await adminLogin(ctx, adminSecret);
    const id = await registerVerified(ctx, 'ray@gmail.com');
    await admin.post(`/admin/api/users/${id}/approve`);
    await ctx.owner.query(`UPDATE app.users SET access_expires_at = now() + interval '2 days' WHERE id = $1`, [id]);
    const wm = new MemoryMailer();
    expect((await schedulerTick(worker, wm, () => undefined)).warned).toBe(1);
    expect((await schedulerTick(worker, wm, () => undefined)).warned).toBe(0);
    await ctx.owner.query(`UPDATE app.users SET access_expires_at = now() + interval '10 hours' WHERE id = $1`, [id]);
    expect((await schedulerTick(worker, wm, () => undefined)).warned).toBe(1);
  });

  it('permanent deletion needs the typed email and a fresh code, and removes the user\'s data', async () => {
    const admin = await adminLogin(ctx, adminSecret);
    const id = await registerVerified(ctx, 'sam@gmail.com');
    const other = await registerVerified(ctx, 'tia@gmail.com');
    await admin.post(`/admin/api/users/${id}/approve`);
    await login(ctx, 'sam@gmail.com');
    const wrongEmail = await admin.post(`/admin/api/users/${id}/delete`, { confirmEmail: 'tia@gmail.com', code: totpCode(adminSecret, 1) });
    expect(wrongEmail.statusCode).toBe(400);
    const ok = await admin.post(`/admin/api/users/${id}/delete`, { confirmEmail: 'sam@gmail.com', code: totpCode(adminSecret, 1) });
    expect(ok.statusCode).toBe(200);
    const { rows } = await ctx.owner.query(
      `SELECT (SELECT count(*) FROM app.users WHERE id = $1)::int AS u, (SELECT count(*) FROM app.sessions WHERE user_id = $1)::int AS s,
              (SELECT count(*) FROM app.access_periods WHERE user_id = $1)::int AS p, (SELECT count(*) FROM app.users WHERE id = $2)::int AS other`, [id, other]);
    expect(rows[0]).toEqual({ u: 0, s: 0, p: 0, other: 1 });
    expect((await login(ctx, 'sam@gmail.com')).status).toBe(401);
  });
});

describe('admin recovery', () => {
  it('password reset via the recovery email still needs the second factor', async () => {
    const admin = await adminLogin(ctx, adminSecret);
    await admin.patch('/admin/api/settings', { adminNotifyEmail: 'recovery@example.net' });
    await ctx.admin.inject({ method: 'POST', url: '/admin/api/auth/password-reset/request', payload: { email: ADMIN_EMAIL } });
    const mail = ctx.mailer.lastTo('recovery@example.net')!;
    const token = tokenFromMail(mail.text);
    const noCode = await ctx.admin.inject({ method: 'POST', url: '/admin/api/auth/password-reset/confirm', payload: { token, newPassword: 'another long admin phrase' } });
    expect(noCode.statusCode).toBe(401);
    const ok = await ctx.admin.inject({ method: 'POST', url: '/admin/api/auth/password-reset/confirm', payload: { token, newPassword: 'another long admin phrase', recoveryCode: recovery[1] } });
    expect(ok.statusCode).toBe(200);
  });

  it('emergency token (created with server access) resets password and second factor', async () => {
    const { randomToken, sha256 } = await import('../src/lib/crypto.js');
    const token = randomToken();
    await ctx.owner.query(`INSERT INTO app.auth_tokens (user_id, purpose, token_hash, expires_at)
      SELECT id, 'admin_emergency', $1, now() + interval '15 minutes' FROM app.users WHERE role = 'admin'`, [sha256(token)]);
    const r = await ctx.admin.inject({ method: 'POST', url: '/admin/api/auth/emergency', payload: { token, newPassword: 'emergency long passphrase' } });
    expect(r.statusCode).toBe(200);
    const { secret, recoveryCodes } = r.json();
    expect(recoveryCodes).toHaveLength(10);
    const reuse = await ctx.admin.inject({ method: 'POST', url: '/admin/api/auth/emergency', payload: { token, newPassword: 'emergency long passphrase' } });
    expect(reuse.statusCode).toBe(400);
    // Old secret no longer works; new one does.
    const r1 = await ctx.admin.inject({ method: 'POST', url: '/admin/api/auth/login', payload: { email: ADMIN_EMAIL, password: 'emergency long passphrase' } });
    const jar = Object.fromEntries(r1.cookies.map((c) => [c.name, c.value]));
    expect((await ctx.admin.inject({ method: 'POST', url: '/admin/api/auth/mfa', cookies: jar, payload: { code: totpCode(adminSecret) } })).statusCode).toBe(401);
    expect((await ctx.admin.inject({ method: 'POST', url: '/admin/api/auth/mfa', cookies: jar, payload: { code: totpCode(secret) } })).statusCode).toBe(200);
  });
});
