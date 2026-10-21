import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, login, makeCtx, PASSWORD, registerVerified, resetData, tokenFromMail, type Ctx } from './helpers.js';

let ctx: Ctx;
beforeAll(async () => { ctx = await makeCtx(); });
afterAll(async () => { await ctx.close(); });
beforeEach(() => resetData(ctx));

const approve = (ctx: Ctx, id: string) =>
  ctx.owner.query(`UPDATE app.users SET status = 'approved', approved_at = now(), access_expires_at = now() + interval '1 month' WHERE id = $1`, [id]);

describe('registration', () => {
  it('requires a Gmail address and a strong password', async () => {
    const r1 = await ctx.api.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'x@yahoo.com', password: PASSWORD } });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error.message).toMatch(/Gmail/);
    const r2 = await ctx.api.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'x@gmail.com', password: 'short' } });
    expect(r2.json().error.code).toBe('weak_password');
  });

  it('cannot log in before email verification, then lands in pending', async () => {
    await ctx.api.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'Dana.Smith@gmail.com', password: PASSWORD, timezone: 'Africa/Lagos' } });
    expect((await login(ctx, 'dana.smith@gmail.com')).body.error.code).toBe('email_not_verified');
    const mail = ctx.mailer.lastTo('dana.smith@gmail.com')!;
    expect(mail.subject).toMatch(/Confirm/);
    const v = await ctx.api.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token: tokenFromMail(mail.text) } });
    expect(v.statusCode).toBe(200);
    // Token is single use.
    const again = await ctx.api.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token: tokenFromMail(mail.text) } });
    expect(again.json().error.code).toBe('invalid_token');

    const l = await login(ctx, 'danasmith+anything@googlemail.com'); // same normalised address
    expect(l.status).toBe(200);
    expect(l.body.account.displayStatus).toBe('pending');
    expect(l.body.account.timezone).toBe('Africa/Lagos');
    const home = await ctx.api.inject({ method: 'GET', url: '/v1/app/home', headers: bearer(l.body.accessToken) });
    expect(home.statusCode).toBe(403);
    expect(home.json().error.code).toBe('account_pending');
    const me = await ctx.api.inject({ method: 'GET', url: '/v1/me', headers: bearer(l.body.accessToken) });
    expect(me.statusCode).toBe(200);
  });

  it('does not reveal existing accounts and does not create duplicates', async () => {
    await registerVerified(ctx, 'erin@gmail.com');
    ctx.mailer.sent.length = 0;
    const r = await ctx.api.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'e.r.i.n@gmail.com', password: 'another good password' } });
    expect(r.statusCode).toBe(202);
    const { rows } = await ctx.owner.query(`SELECT count(*)::int AS n FROM app.users WHERE email_normalized = 'erin@gmail.com'`);
    expect(rows[0].n).toBe(1);
    expect(ctx.mailer.sent[0]?.subject).toMatch(/already have an account/);
    expect((await login(ctx, 'erin@gmail.com', 'another good password')).body.error.code).toBe('invalid_credentials');
  });

  it('serves the email-link pages without consuming the token on GET', async () => {
    await ctx.api.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'fay@gmail.com', password: PASSWORD } });
    const token = tokenFromMail(ctx.mailer.lastTo('fay@gmail.com')!.text);
    const g = await ctx.api.inject({ method: 'GET', url: `/v1/pages/verify-email?token=${token}` });
    expect(g.statusCode).toBe(200);
    expect(g.headers['content-security-policy']).toMatch(/default-src 'none'/);
    const p = await ctx.api.inject({ method: 'POST', url: '/v1/pages/verify-email', payload: `token=${token}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(p.body).toMatch(/Email confirmed/);
  });
});

describe('sessions', () => {
  it('rotates refresh tokens and revokes the family when an old one is reused', async () => {
    const id = await registerVerified(ctx, 'gus@gmail.com');
    await approve(ctx, id);
    const l = await login(ctx, 'gus@gmail.com');
    const r1 = await ctx.api.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: l.body.refreshToken } });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().refreshToken).not.toBe(l.body.refreshToken);
    // Replaying the first (already rotated) token = theft signal.
    const replay = await ctx.api.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: l.body.refreshToken } });
    expect(replay.statusCode).toBe(401);
    const r2 = await ctx.api.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: r1.json().refreshToken } });
    expect(r2.statusCode).toBe(401);
    const home = await ctx.api.inject({ method: 'GET', url: '/v1/app/home', headers: bearer(r1.json().accessToken) });
    expect(home.json().error.code).toBe('session_revoked');
  });

  it('a user cannot revoke another user\'s session', async () => {
    const a = await registerVerified(ctx, 'hal@gmail.com');
    const b = await registerVerified(ctx, 'ivy@gmail.com');
    await approve(ctx, a); await approve(ctx, b);
    const la = await login(ctx, 'hal@gmail.com');
    const lb = await login(ctx, 'ivy@gmail.com');
    const sb = await ctx.api.inject({ method: 'GET', url: '/v1/me/sessions', headers: bearer(lb.body.accessToken) });
    const bSession = sb.json().sessions[0].id;
    const del = await ctx.api.inject({ method: 'DELETE', url: `/v1/me/sessions/${bSession}`, headers: bearer(la.body.accessToken) });
    expect(del.statusCode).toBe(404);
    const stillOk = await ctx.api.inject({ method: 'GET', url: '/v1/app/home', headers: bearer(lb.body.accessToken) });
    expect(stillOk.statusCode).toBe(200);
  });

  it('logout ends the session immediately', async () => {
    const id = await registerVerified(ctx, 'jay@gmail.com');
    await approve(ctx, id);
    const l = await login(ctx, 'jay@gmail.com');
    expect((await ctx.api.inject({ method: 'POST', url: '/v1/auth/logout', headers: bearer(l.body.accessToken) })).statusCode).toBe(204);
    expect((await ctx.api.inject({ method: 'GET', url: '/v1/me', headers: bearer(l.body.accessToken) })).statusCode).toBe(401);
  });

  it('throttles repeated failed logins per account', async () => {
    await registerVerified(ctx, 'kim@gmail.com');
    for (let i = 0; i < 5; i++) expect((await login(ctx, 'kim@gmail.com', 'wrong password!!')).status).toBe(401);
    const blocked = await login(ctx, 'kim@gmail.com');
    expect(blocked.status).toBe(429);
  });
});

describe('password reset', () => {
  it('resets via emailed link, revokes sessions, and does not reveal unknown addresses', async () => {
    const id = await registerVerified(ctx, 'lee@gmail.com');
    await approve(ctx, id);
    const l = await login(ctx, 'lee@gmail.com');
    const unknown = await ctx.api.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { email: 'nobody@gmail.com' } });
    expect(unknown.statusCode).toBe(202);
    await ctx.api.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { email: 'lee@gmail.com' } });
    const token = tokenFromMail(ctx.mailer.lastTo('lee@gmail.com')!.text);
    const weak = await ctx.api.inject({ method: 'POST', url: '/v1/auth/password-reset/confirm', payload: { token, newPassword: 'short' } });
    expect(weak.json().error.code).toBe('weak_password');
    const ok = await ctx.api.inject({ method: 'POST', url: '/v1/auth/password-reset/confirm', payload: { token, newPassword: 'brand new pass phrase' } });
    expect(ok.statusCode).toBe(200);
    expect((await ctx.api.inject({ method: 'GET', url: '/v1/me', headers: bearer(l.body.accessToken) })).statusCode).toBe(401);
    expect((await login(ctx, 'lee@gmail.com', 'brand new pass phrase')).status).toBe(200);
  });
});
