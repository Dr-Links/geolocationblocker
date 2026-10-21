import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, withUser, type Db } from '../src/lib/db.js';
import { makeCtx, registerVerified, resetData, type Ctx } from './helpers.js';

let ctx: Ctx;
let api: Db;
beforeAll(async () => {
  ctx = await makeCtx();
  api = createPool(ctx.cfg, 'api');
});
afterAll(async () => {
  await api.end();
  await ctx.close();
});
beforeEach(() => resetData(ctx));

describe('calendar month', () => {
  const add = async (ts: string, tz: string) => {
    const { rows } = await ctx.owner.query<{ local: string }>(
      `SELECT to_char(app.add_calendar_month($1::timestamptz, $2) AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS local`, [ts, tz]);
    return rows[0]!.local;
  };
  it('clamps to the end of shorter months', async () => {
    expect(await add('2027-01-31 15:00 Africa/Lagos', 'Africa/Lagos')).toBe('2027-02-28 15:00');
    expect(await add('2028-01-31 15:00 Africa/Lagos', 'Africa/Lagos')).toBe('2028-02-29 15:00');
    expect(await add('2027-03-31 08:00 Europe/London', 'Europe/London')).toBe('2027-04-30 08:00');
  });
  it('keeps the local wall-clock time across daylight-saving changes', async () => {
    expect(await add('2027-03-10 09:00 America/New_York', 'America/New_York')).toBe('2027-04-10 09:00');
    expect(await add('2027-10-15 09:00 Europe/Berlin', 'Europe/Berlin')).toBe('2027-11-15 09:00');
  });
  it('uses the user zone: same instant, different expiry instants', async () => {
    const { rows } = await ctx.owner.query<{ lagos: Date; la: Date }>(
      `SELECT app.add_calendar_month('2027-01-30 23:30Z', 'Africa/Lagos') AS lagos,
              app.add_calendar_month('2027-01-30 23:30Z', 'America/Los_Angeles') AS la`);
    // 23:30Z on 30 Jan is already 31 Jan 00:30 in Lagos (-> 28 Feb 00:30 local),
    // but still 30 Jan 15:30 in Los Angeles (-> 28 Feb 15:30 local).
    expect(rows[0]!.lagos.toISOString()).toBe('2027-02-27T23:30:00.000Z');
    expect(rows[0]!.la.toISOString()).toBe('2027-02-28T23:30:00.000Z');
  });
});

describe('database constraints and isolation', () => {
  it('allows only one administrator and only Gmail users', async () => {
    await ctx.owner.query(`INSERT INTO app.users (email_normalized, email_display, password_hash, role, status, access_expires_at) VALUES ('a@x.org','a@x.org','h','admin','approved','infinity')`);
    await expect(ctx.owner.query(`INSERT INTO app.users (email_normalized, email_display, password_hash, role) VALUES ('b@x.org','b@x.org','h','admin')`)).rejects.toThrow(/users_single_admin/);
    await expect(ctx.owner.query(`INSERT INTO app.users (email_normalized, email_display, password_hash) VALUES ('c@yahoo.com','c','h')`)).rejects.toThrow(/users_gmail_only/);
  });

  it('row-level security hides other users and blocks escalation', async () => {
    const a = await registerVerified(ctx, 'alice@gmail.com');
    const b = await registerVerified(ctx, 'bob@gmail.com');
    await withUser(api, a, async (c) => {
      const users = await c.query(`SELECT id FROM users`);
      expect(users.rows).toEqual([{ id: a }]);
      const upd = await c.query(`UPDATE users SET timezone = 'UTC' WHERE id = $1`, [b]);
      expect(upd.rowCount).toBe(0);
    });
    await expect(withUser(api, a, (c) => c.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [a]))).rejects.toThrow(/permission denied/);
    await expect(withUser(api, a, (c) => c.query(`UPDATE users SET status = 'approved' WHERE id = $1`, [a]))).rejects.toThrow(/permission denied/);
    await expect(withUser(api, a, (c) => c.query(`DELETE FROM audit_log`))).rejects.toThrow(/permission denied/);
    await expect(withUser(api, a, (c) => c.query(`SELECT * FROM auth_tokens`))).rejects.toThrow(/permission denied/);
  });

  it('api role cannot call admin lifecycle functions', async () => {
    const a = await registerVerified(ctx, 'carol@gmail.com');
    await expect(withUser(api, a, (c) => c.query(`SELECT * FROM app.grant_access($1, $1, 'approve', null)`, [a]))).rejects.toThrow(/permission denied/);
  });
});

describe('migration safety checks', () => {
  it('refuses to migrate if a runtime user inherits the owner role', async () => {
    const { checkServer } = await import('../src/lib/migrate.js');
    await checkServer(ctx.owner, ctx.cfg); // normal setup passes
    const bad = { ...ctx.cfg, db: { ...ctx.cfg.db, users: { ...ctx.cfg.db.users, api: 't_owner' } } };
    await expect(checkServer(ctx.owner, bad)).rejects.toThrow(/Unsafe database user setup: t_owner is the same user as the owner/);
  });
});
