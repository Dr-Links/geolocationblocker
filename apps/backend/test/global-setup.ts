import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../src/lib/config.js';
import { createPool } from '../src/lib/db.js';
import { migrate } from '../src/lib/migrate.js';
import { TEST_DB, testEnv } from './env.js';

// Creates a fresh database owned by a NON-superuser (like a cPanel database user), creates the
// runtime database users, and applies all migrations as that owner.
export default async function setup() {
  // Real IMAP server (Dovecot) for mailbox tests. CI installs it with apt.
  // In CI it is started beforehand with sudo (MAILTEST_EXTERNAL=1).
  if (!process.env.MAILTEST_EXTERNAL) {
    execFileSync(join(dirname(fileURLToPath(import.meta.url)), 'mailserver/start-dovecot.sh'), { stdio: 'inherit' });
  }

  const su = new pg.Client({
    host: process.env.TEST_PG_HOST ?? 'localhost',
    port: Number(process.env.TEST_PG_PORT ?? 5432),
    user: process.env.TEST_PG_SUPERUSER ?? 'postgres',
    password: process.env.TEST_PG_PASSWORD,
    database: 'postgres',
  });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  for (const role of ['t_owner', 't_auth', 't_api', 't_admin', 't_worker']) {
    const exists = await su.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role]);
    await su.query(`${exists.rowCount ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN NOSUPERUSER NOCREATEROLE PASSWORD 'test'`);
  }
  await su.query(`CREATE DATABASE ${TEST_DB} OWNER t_owner`);
  await su.end();

  const cfg = loadConfig(testEnv());
  const owner = createPool(cfg, 'owner', 1);
  await migrate(owner, cfg, () => undefined);
  await owner.end();
}
