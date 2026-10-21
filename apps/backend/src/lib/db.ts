import pg from 'pg';
import type { Config, DbRole } from './config.js';

// Return bigint (int8) columns as JS numbers; counts and byte sizes here stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(cfg: Config, role: DbRole, max = 5): Db {
  const pool = new pg.Pool({
    host: cfg.db.host,
    port: cfg.db.port,
    database: cfg.db.database,
    user: cfg.db.users[role],
    password: cfg.db.passwords[role],
    ssl: cfg.db.ssl ? { rejectUnauthorized: true } : undefined,
    max,
    idleTimeoutMillis: 30_000,
    application_name: `emailplatform-${role}`,
    options: '-c search_path=app,pg_catalog',
  });
  pool.on('error', (err) => {
    // An idle client lost its connection; the pool replaces it. Log without crashing.
    console.error(`[db:${role}] idle client error: ${err.message}`);
  });
  return pool;
}

export async function tx<T>(pool: Db, fn: (c: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Runs fn in a transaction whose Row-Level Security context is the given user. */
export function withUser<T>(pool: Db, userId: string, fn: (c: Tx) => Promise<T>): Promise<T> {
  return tx(pool, async (c) => {
    await c.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    return fn(c);
  });
}
