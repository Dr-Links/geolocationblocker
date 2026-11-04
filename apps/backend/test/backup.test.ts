import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptBackup, listBackups, restoreTest, runBackup } from '../src/backup/backup.js';
import { adminLogin, createAdmin, makeCtx, registerVerified, resetData, totpCode, type Ctx } from './helpers.js';

const hasPgDump = (() => {
  try {
    execFileSync('pg_dump', ['--version']);
    return true;
  } catch {
    return false;
  }
})();
const SCRATCH = 'emailplatform_restore_test';
const KEY = randomBytes(32).toString('base64');
const DIR = '/var/tmp/emailplatform-test-backups';

const su = () => new pg.Client({ host: process.env.TEST_PG_HOST ?? 'localhost', port: Number(process.env.TEST_PG_PORT ?? 5432),
  user: process.env.TEST_PG_SUPERUSER ?? 'postgres', password: process.env.TEST_PG_PASSWORD, database: 'postgres' });

let ctx: Ctx;
beforeAll(async () => {
  rmSync(DIR, { recursive: true, force: true });
  ctx = await makeCtx({ env: { BACKUP_KEY: KEY, BACKUP_KEEP: '2' } });
  await resetData(ctx);
});
afterAll(async () => {
  await ctx.close();
  const c = su();
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
  await c.end();
});

describe.skipIf(!hasPgDump)('backups and the deletion ledger', () => {
  it('makes encrypted backups, keeps the newest ones, and a restore never brings a deleted user back', async () => {
    const keep = await registerVerified(ctx, 'stays@gmail.com');
    const gone = await registerVerified(ctx, 'leaves@gmail.com');
    await ctx.owner.query(`UPDATE app.users SET status = 'approved', access_expires_at = now() + interval '1 month' WHERE id = ANY($1)`, [[keep, gone]]);

    const b = await runBackup(ctx.cfg, ctx.owner, () => undefined);
    const file = readFileSync(join(DIR, b.name));
    expect(file.includes(Buffer.from('leaves@gmail.com'))).toBe(false);       // encrypted
    const plain = decryptBackup(Buffer.from(KEY, 'base64'), file);
    expect(plain.subarray(0, 5).toString()).toBe('PGDMP');
    const tampered = Buffer.from(file);
    tampered[tampered.length - 20] = tampered[tampered.length - 20]! ^ 1;
    expect(() => decryptBackup(Buffer.from(KEY, 'base64'), tampered)).toThrow();
    const { rows } = await ctx.owner.query(`SELECT status, size_bytes FROM app.backup_runs ORDER BY started_at DESC LIMIT 1`);
    expect(rows[0]).toMatchObject({ status: 'succeeded' });

    // The admin deletes a user after the backup was taken: recorded in the ledger outside the database.
    const { secret } = await createAdmin(ctx);
    const admin = await adminLogin(ctx, secret);
    expect((await admin.post(`/admin/api/users/${gone}/delete`, { confirmEmail: 'leaves@gmail.com', code: totpCode(secret, 1) })).statusCode).toBe(200);
    expect(readdirSync(join(DIR, 'ledger')).some((f) => f.endsWith(`${gone}.json`))).toBe(true);

    // Restore last backup into a scratch database: the deleted user is removed again.
    const c = su();
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${SCRATCH} OWNER t_owner`);
    await c.end();
    const r = await restoreTest(ctx.cfg, b.name, SCRATCH);
    expect(r.reapplied).toBe(1);
    const scratch = new pg.Client({ host: ctx.cfg.db.host, port: ctx.cfg.db.port, user: 't_owner', password: 'test', database: SCRATCH });
    await scratch.connect();
    const emails = (await scratch.query(`SELECT email_normalized FROM app.users WHERE role = 'user' ORDER BY 1`)).rows.map((x) => x.email_normalized);
    // Runtime roles keep their rights after a restore.
    const grants = (await scratch.query(`SELECT has_table_privilege('t_api', 'app.messages', 'SELECT') AS ok`)).rows[0].ok;
    await scratch.end();
    expect(emails).toEqual(['stays@gmail.com']);
    expect(grants).toBe(true);
    await expect(restoreTest(ctx.cfg, b.name, SCRATCH)).rejects.toThrow(/not empty/);

    // Retention: only the newest BACKUP_KEEP (2) remain.
    await runBackup(ctx.cfg, ctx.owner, () => undefined);
    await new Promise((res) => setTimeout(res, 10));
    await runBackup(ctx.cfg, ctx.owner, () => undefined);
    expect(await listBackups(ctx.cfg)).toHaveLength(2);
    expect(existsSync(join(DIR, b.name))).toBe(false);
  });
});
