import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizeActivationCode } from '../src/lib/activation.js';
import { adminLogin, bearer, createAdmin, login, makeCtx, registerVerified, resetData, type Ctx } from './helpers.js';

let ctx: Ctx;
let admin: Awaited<ReturnType<typeof adminLogin>>;
beforeAll(async () => { ctx = await makeCtx(); });
afterAll(async () => { await ctx.close(); });
beforeEach(async () => {
  await resetData(ctx);
  await ctx.owner.query(`TRUNCATE app.activation_codes CASCADE`);
  const { secret } = await createAdmin(ctx);
  admin = await adminLogin(ctx, secret);
});

const newCodes = async (payload: object = {}) => {
  const r = await admin.post('/admin/api/activation-codes', payload);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().codes as Array<{ id: string; code: string }>;
};
const userWithToken = async (email: string) => {
  const id = await registerVerified(ctx, email);
  const token = (await login(ctx, email)).body.accessToken as string;
  return { id, token };
};
const redeem = (token: string, code: string) => ctx.api.inject({ method: 'POST', url: '/v1/me/activation-code', headers: bearer(token), payload: { code } });

describe('activation codes', () => {
  it('a code activates exactly one account, once', async () => {
    const [c] = await newCodes({ months: 1, note: 'Paid by bank transfer #1001' });
    expect(c!.code).toMatch(/^AWM-[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){3}$/);
    const a = await userWithToken('first.customer@gmail.com');
    const b = await userWithToken('second.customer@gmail.com');
    expect((await ctx.api.inject({ method: 'GET', url: '/v1/me', headers: bearer(a.token) })).json().account.displayStatus).toBe('pending');

    // Typed loosely: lower case, spaces instead of dashes.
    const ok = await redeem(a.token, c!.code.toLowerCase().replace(/-/g, ' '));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().account.displayStatus).toBe('active');
    const days = (new Date(ok.json().accessExpiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);

    const again = await redeem(b.token, c!.code);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toMatch(/already been used/);
    expect((await redeem(a.token, c!.code)).statusCode).toBe(409);

    const list = (await admin.get('/admin/api/activation-codes')).json().codes;
    expect(list[0]).toMatchObject({ status: 'used', usedByEmail: 'first.customer@gmail.com', note: 'Paid by bank transfer #1001', months: 1 });
    const { rows: periods } = await ctx.owner.query(`SELECT kind, payment_note FROM app.access_periods WHERE user_id = $1`, [a.id]);
    expect(periods).toEqual([{ kind: 'approval', payment_note: expect.stringContaining('Activation code') }]);
  });

  it('only one of two accounts wins when both use the same code at the same moment', async () => {
    const [c] = await newCodes();
    const users = await Promise.all(['race.one@gmail.com', 'race.two@gmail.com', 'race.three@gmail.com'].map(userWithToken));
    const results = await Promise.all(users.map((u) => redeem(u.token, c!.code)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    const { rows } = await ctx.owner.query(`SELECT count(*)::int AS n FROM app.users WHERE status = 'approved' AND role = 'user'`);
    expect(rows[0].n).toBe(1);
  });

  it('codes can be locked to an email, revoked, or given an expiry date', async () => {
    const [locked] = await newCodes({ forEmail: 'Only.This.One@googlemail.com' });
    const other = await userWithToken('someone.else@gmail.com');
    expect((await redeem(other.token, locked!.code)).json().error.message).toMatch(/different account/);
    const owner = await userWithToken('onlythisone@gmail.com');
    expect((await redeem(owner.token, locked!.code)).statusCode).toBe(200);

    const [rev] = await newCodes();
    expect((await admin.post(`/admin/api/activation-codes/${rev!.id}/revoke`)).statusCode).toBe(200);
    expect((await redeem(other.token, rev!.code)).json().error.message).toMatch(/cancelled/);
    expect((await admin.post(`/admin/api/activation-codes/${locked!.id}/revoke`)).statusCode).toBe(409); // already used

    const [exp] = await newCodes({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await ctx.owner.query(`UPDATE app.activation_codes SET expires_at = now() - interval '1 second' WHERE id = $1`, [exp!.id]);
    expect((await redeem(other.token, exp!.code)).json().error.message).toMatch(/expired/);
    expect((await admin.get('/admin/api/activation-codes?status=unused')).json().codes).toHaveLength(1); // the expired one
  });

  it('renews an expired account and extends an active one; never revives a suspended or rejected one', async () => {
    const u = await userWithToken('renewing@gmail.com');
    const [c1, c2, c3] = await newCodes({ count: 3, months: 2 });
    await ctx.owner.query(`UPDATE app.users SET status = 'suspended', suspension_reason = 'expired', access_expires_at = now() - interval '1 day' WHERE id = $1`, [u.id]);
    const t2 = (await login(ctx, 'renewing@gmail.com')).body.accessToken as string;
    const r1 = await redeem(t2, c1!.code);
    expect(r1.statusCode, r1.body).toBe(200);
    const end1 = new Date(r1.json().accessExpiresAt).getTime();
    expect((end1 - Date.now()) / 86_400_000).toBeGreaterThan(58);
    // Active: the new period starts where the current one ends.
    const r2 = await redeem(t2, c2!.code);
    expect((new Date(r2.json().accessExpiresAt).getTime() - end1) / 86_400_000).toBeGreaterThan(58);

    await ctx.owner.query(`UPDATE app.users SET status = 'suspended', suspension_reason = 'admin_action' WHERE id = $1`, [u.id]);
    const t3 = (await login(ctx, 'renewing@gmail.com')).body.accessToken as string;
    expect((await redeem(t3, c3!.code)).statusCode).toBe(403);
    expect((await admin.get('/admin/api/activation-codes?status=unused')).json().codes).toHaveLength(1); // c3 not consumed
  });

  it('limits guessing and never stores the codes themselves', async () => {
    const [c] = await newCodes();
    const u = await userWithToken('guesser@gmail.com');
    for (let i = 0; i < 10; i++) expect((await redeem(u.token, `AWM-2222-3333-4444-${String(5000 + i).replace(/[01]/g, '7')}`)).statusCode).toBe(400);
    const blocked = await redeem(u.token, c!.code);
    expect(blocked.statusCode).toBe(429);
    const dump = JSON.stringify((await ctx.owner.query(`SELECT * FROM app.activation_codes`)).rows);
    expect(dump).not.toContain(normalizeActivationCode(c!.code)!);
    expect(dump).not.toContain(c!.code);
    expect(normalizeActivationCode('awm 2345-6789 abcd efgh')).toBe('23456789ABCDEFGH');
    expect(normalizeActivationCode('too short')).toBeNull();
  });

  it('gives 6-month and 1-year access periods', async () => {
    const [six] = await newCodes({ months: 6 });
    const [year] = await newCodes({ months: 12 });
    const a = await userWithToken('six.months@gmail.com');
    const b = await userWithToken('one.year@gmail.com');
    const days = async (token: string, code: string) => {
      const r = await redeem(token, code);
      expect(r.statusCode, r.body).toBe(200);
      return Math.round((new Date(r.json().accessExpiresAt).getTime() - Date.now()) / 86_400_000);
    };
    expect(await days(a.token, six!.code)).toBeGreaterThanOrEqual(181);
    expect(await days(a.token, six!.code).catch(() => 'used')).toBe('used');
    const y = await days(b.token, year!.code);
    expect(y === 365 || y === 366).toBe(true);
    const list = (await admin.get('/admin/api/activation-codes?status=used')).json().codes.map((c: { months: number }) => c.months).sort((x: number, z: number) => x - z);
    expect(list).toEqual([6, 12]);
  });
});
