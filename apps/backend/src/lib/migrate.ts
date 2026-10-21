import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import type { Db } from './db.js';

export const MIN_PG_VERSION = 130000;

export function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '../migrations'), join(here, '../../migrations')]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('migrations directory not found (set MIGRATIONS_DIR)');
}

interface Migration {
  version: string;
  sql: string;
  checksum: string;
}

function loadMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = readFileSync(join(dir, f), 'utf8');
      return { version: f.replace(/\.sql$/, ''), sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/** The database users the application connects as. They must exist before migrating (create them in cPanel). */
export function runtimeRoles(cfg: Config) {
  return { role_auth: cfg.db.users.auth, role_api: cfg.db.users.api, role_admin: cfg.db.users.admin, role_worker: cfg.db.users.worker };
}

function render(sql: string, roles: Record<string, string>, quote: (s: string) => string): string {
  return sql.replace(/\{\{(role_[a-z]+)\}\}/g, (_, key: string) => {
    const name = roles[key];
    if (!name) throw new Error(`unknown placeholder ${key}`);
    return quote(name);
  });
}

export async function checkServer(owner: Db, cfg: Config): Promise<void> {
  const { rows } = await owner.query<{ v: number }>(`SELECT current_setting('server_version_num')::int AS v`);
  if ((rows[0]?.v ?? 0) < MIN_PG_VERSION) {
    throw new Error(`PostgreSQL 13 or newer is required (server reports ${rows[0]?.v}). Ask your host for a newer version.`);
  }
  const wanted = Object.values(runtimeRoles(cfg));
  const { rows: found } = await owner.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname = ANY($1)`, [wanted]);
  const missing = wanted.filter((w) => !found.some((f) => f.rolname === w));
  if (missing.length) {
    throw new Error(`These database users do not exist yet: ${missing.join(', ')}. Create them (cPanel → PostgreSQL Databases) and add them to the database first.`);
  }
  // Isolation depends on the runtime users NOT having the owner's rights. Some hosting setups make
  // database users members of a shared role; that would silently bypass Row-Level Security.
  const { rows: risky } = await owner.query<{ rolname: string; why: string }>(
    `SELECT r.rolname,
            CASE WHEN r.rolsuper THEN 'is a superuser'
                 WHEN r.rolbypassrls THEN 'has BYPASSRLS'
                 WHEN r.rolname = current_user THEN 'is the same user as the owner'
                 WHEN pg_has_role(r.oid, current_user, 'USAGE') THEN 'inherits the owner''s privileges' END AS why
       FROM pg_roles r WHERE r.rolname = ANY($1)`, [wanted]);
  const bad = risky.filter((r) => r.why);
  if (bad.length) {
    throw new Error(`Unsafe database user setup: ${bad.map((b) => `${b.rolname} ${b.why}`).join('; ')}. ` +
      'Use separate users for owner / auth / api / admin / worker, none of them a member of another.');
  }
}

export async function migrate(owner: Db, cfg: Config, log: (m: string) => void = console.log): Promise<string[]> {
  await checkServer(owner, cfg);
  const migrations = loadMigrations(migrationsDir());
  const applied: string[] = [];
  const client = await owner.connect();
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS app_meta');
    await client.query(`CREATE TABLE IF NOT EXISTS app_meta.migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query('SELECT pg_advisory_lock(727001)');
    const { rows } = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM app_meta.migrations');
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const m of migrations) {
      const prev = done.get(m.version);
      if (prev) {
        if (prev !== m.checksum) throw new Error(`Migration ${m.version} was modified after being applied. Add a new migration instead.`);
        continue;
      }
      const sql = render(m.sql, runtimeRoles(cfg), (s) => client.escapeIdentifier(s));
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO app_meta.migrations (version, checksum) VALUES ($1, $2)', [m.version, m.checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.version} failed: ${(err as Error).message}`);
      }
      applied.push(m.version);
      log(`applied ${m.version}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    client.release();
  }
  return applied;
}
