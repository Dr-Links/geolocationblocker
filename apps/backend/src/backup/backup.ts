import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { Config } from '../lib/config.js';
import { createPool, type Db } from '../lib/db.js';
import { S3BlobStore } from '../storage/s3.js';

const MAGIC = Buffer.from('AWMBK1\n');

/** Where backups and the deletion ledger are kept: a local folder or an S3-compatible bucket. */
export interface BackupTarget {
  readonly name: string;
  put(rel: string, file: string): Promise<void>;
  putSmall(rel: string, data: Buffer): Promise<void>;
  get(rel: string): Promise<Buffer>;
  list(relPrefix: string): Promise<string[]>;
  delete(rel: string): Promise<void>;
}

const safeRel = (rel: string) => {
  if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(rel) || rel.includes('..')) throw new Error(`invalid backup name: ${rel}`);
  return rel;
};

class LocalTarget implements BackupTarget {
  readonly name: string;
  constructor(private readonly dir: string) {
    this.name = `local:${resolve(dir)}`;
  }
  private p(rel: string) {
    return join(resolve(this.dir), safeRel(rel));
  }
  async put(rel: string, file: string) {
    const to = this.p(rel);
    await mkdir(join(to, '..'), { recursive: true, mode: 0o700 });
    await rename(file, to);
  }
  async putSmall(rel: string, data: Buffer) {
    const to = this.p(rel);
    await mkdir(join(to, '..'), { recursive: true, mode: 0o700 });
    const tmp = `${to}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, to);
  }
  get(rel: string) {
    return readFile(this.p(rel));
  }
  async list(relPrefix: string) {
    const dir = this.p(relPrefix.replace(/\/$/, ''));
    try {
      return (await readdir(dir)).filter((f) => !f.endsWith('.tmp')).sort().map((f) => `${relPrefix.replace(/\/?$/, '/')}${f}`);
    } catch {
      return [];
    }
  }
  async delete(rel: string) {
    await rm(this.p(rel), { force: true });
  }
}

class S3Target implements BackupTarget {
  readonly name: string;
  private readonly s3: S3BlobStore;
  constructor(o: NonNullable<Config['backup']['s3']>) {
    this.s3 = new S3BlobStore(o);
    this.name = `s3:${o.bucket}/${o.prefix ?? ''}`;
  }
  async put(rel: string, file: string) {
    // Single upload (S3 limit 5 GB per request). Larger databases should use pgBackRest instead.
    await this.s3.putObject(safeRel(rel), await readFile(file));
    await rm(file, { force: true });
  }
  putSmall(rel: string, data: Buffer) {
    return this.s3.putObject(safeRel(rel), data);
  }
  get(rel: string) {
    return this.s3.getObject(safeRel(rel));
  }
  list(relPrefix: string) {
    return this.s3.listObjects(relPrefix);
  }
  delete(rel: string) {
    return this.s3.deleteObject(safeRel(rel));
  }
}

export function backupTarget(cfg: Config): BackupTarget {
  return cfg.backup.s3 ? new S3Target(cfg.backup.s3) : new LocalTarget(cfg.backup.dir);
}

/** AES-256-GCM: MAGIC | iv (12) | ciphertext | tag (16). */
function encryptor(key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  let started = false;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const out = cipher.update(chunk);
      if (!started) {
        started = true;
        cb(null, Buffer.concat([MAGIC, iv, out]));
      } else cb(null, out);
    },
    flush(cb) {
      const head = started ? Buffer.alloc(0) : Buffer.concat([MAGIC, iv]);
      cb(null, Buffer.concat([head, cipher.final(), cipher.getAuthTag()]));
    },
  });
}

export function decryptBackup(key: Buffer, data: Buffer): Buffer {
  if (!data.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a backup file of this platform');
  const iv = data.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = data.subarray(data.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(MAGIC);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data.subarray(MAGIC.length + 12, data.length - 16)), d.final()]);
}

function pgEnv(cfg: Config) {
  return {
    ...process.env,
    PGHOST: cfg.db.host, PGPORT: String(cfg.db.port), PGDATABASE: cfg.db.database, PGUSER: cfg.db.users.owner,
    PGPASSWORD: cfg.db.passwords.owner ?? '', PGSSLMODE: cfg.db.ssl ? 'require' : 'prefer',
  };
}

/**
 * Encrypted logical backup of the platform database (pg_dump custom format), stored in the backup target.
 * Stored files (attachments) are not included: they are encrypted per user and live in their own store.
 */
export async function runBackup(cfg: Config, owner: Db, log: (m: string) => void = console.log): Promise<{ name: string; sizeBytes: number }> {
  if (!cfg.backup.key) throw new Error('BACKUP_KEY is not set (generate one with keys:generate and keep a copy outside this server)');
  const target = backupTarget(cfg);
  const run = await owner.query<{ id: string }>(`INSERT INTO app.backup_runs (target) VALUES ($1) RETURNING id`, [target.name]);
  const runId = run.rows[0]!.id;
  const name = `db/${new Date().toISOString().replace(/[:.]/g, '-')}.dump.enc`;
  const tmpDir = join(resolve(cfg.backup.dir), 'tmp');
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });
  const tmp = join(tmpDir, `${runId}.part`);
  try {
    const child = spawn(cfg.backup.pgDump, ['-Fc', '--no-owner', '-n', 'app', '-n', 'app_meta'], { env: pgEnv(cfg), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    const exited = new Promise<number>((res, rej) => { child.on('error', rej); child.on('close', (code) => res(code ?? 1)); });
    await pipeline(child.stdout, encryptor(cfg.backup.key), createWriteStream(tmp, { mode: 0o600 }));
    const code = await exited;
    if (code !== 0) throw new Error(`pg_dump failed (${code}): ${stderr.trim().slice(0, 500)}`);
    const size = (await stat(tmp)).size;
    await target.put(name, tmp);
    await owner.query(`UPDATE app.backup_runs SET status = 'succeeded', finished_at = now(), object_key = $2, size_bytes = $3 WHERE id = $1`, [runId, name, size]);
    // Keep the newest N (object stores can use a lifecycle rule instead).
    const all = (await target.list('db/')).filter((k) => k.endsWith('.dump.enc'));
    for (const old of all.slice(0, Math.max(0, all.length - cfg.backup.keep))) await target.delete(old);
    log(`backup stored: ${target.name} ${name} (${size} bytes)`);
    return { name, sizeBytes: size };
  } catch (err) {
    await rm(tmp, { force: true });
    await owner.query(`UPDATE app.backup_runs SET status = 'failed', finished_at = now(), error = left($2, 1000) WHERE id = $1`, [runId, (err as Error).message]);
    throw err;
  }
}

/** Downloads and decrypts a backup into a pg_restore-ready file. */
export async function fetchBackup(cfg: Config, name: string, outFile: string) {
  if (!cfg.backup.key) throw new Error('BACKUP_KEY is not set');
  const plain = decryptBackup(cfg.backup.key, await backupTarget(cfg).get(name));
  await writeFile(outFile, plain, { mode: 0o600 });
  return plain.length;
}

/** Restores a backup into an EMPTY database (e.g. a scratch database to test, or a new server). */
export async function restoreBackup(cfg: Config, name: string, intoDb: Config['db']) {
  const tmp = join(resolve(cfg.backup.dir), 'tmp', `restore-${randomBytes(4).toString('hex')}.dump`);
  await mkdir(join(tmp, '..'), { recursive: true, mode: 0o700 });
  await fetchBackup(cfg, name, tmp);
  try {
    await new Promise<void>((res, rej) => {
      const env = pgEnv({ ...cfg, db: intoDb });
      const child = spawn(cfg.backup.pgRestore, ['--no-owner', '--exit-on-error', '-d', intoDb.database, tmp], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', rej);
      child.on('close', (code) => (code === 0 ? res() : rej(new Error(`pg_restore failed (${code}): ${stderr.trim().slice(0, 500)}`))));
    });
  } finally {
    await rm(tmp, { force: true });
  }
}

export async function listBackups(cfg: Config) {
  return (await backupTarget(cfg).list('db/')).filter((k) => k.endsWith('.dump.enc'));
}

// ---- Deletion ledger --------------------------------------------------------------------------------
// Kept outside the database so that restoring an older backup cannot bring a deleted user back:
// after a restore, `backup:reapply-deletions` deletes them again (their keys go too, so their files stay unreadable).

export async function recordDeletion(cfg: Config, userId: string) {
  const entry = { userId, deletedAt: new Date().toISOString() };
  await backupTarget(cfg).putSmall(`ledger/${entry.deletedAt.replace(/[:.]/g, '-')}-${userId}.json`, Buffer.from(JSON.stringify(entry)));
}

export async function reapplyDeletions(cfg: Config, owner: Db, log: (m: string) => void = console.log): Promise<{ checked: number; deleted: number }> {
  const target = backupTarget(cfg);
  const keys = (await target.list('ledger/')).filter((k) => k.endsWith('.json'));
  let deleted = 0;
  for (const k of keys) {
    const e = JSON.parse((await target.get(k)).toString('utf8')) as { userId: string };
    if (!/^[0-9a-f-]{36}$/.test(e.userId)) continue;
    const r = await owner.query(`DELETE FROM app.users WHERE id = $1 AND role = 'user'`, [e.userId]);
    if (r.rowCount) {
      deleted++;
      log(`deleted again: ${e.userId}`);
    }
  }
  return { checked: keys.length, deleted };
}

/** Restores into a scratch database, removes deleted users again, and counts what came back. */
export async function restoreTest(cfg: Config, name: string, scratchDb: string) {
  const intoDb = { ...cfg.db, database: scratchDb };
  const scratchCfg = { ...cfg, db: intoDb };
  const check = createPool(scratchCfg, 'owner', 1);
  try {
    const existing = await check.query(`SELECT 1 FROM pg_namespace WHERE nspname = 'app'`);
    if (existing.rowCount) throw new Error(`${scratchDb} is not empty; use a new, empty database`);
    await restoreBackup(cfg, name, intoDb);
    const re = await reapplyDeletions(scratchCfg, check, () => undefined);
    const { rows } = await check.query<{ users: number; messages: number }>(
      `SELECT (SELECT count(*)::int FROM app.users) AS users, (SELECT count(*)::int FROM app.messages) AS messages`);
    return { ...rows[0]!, reapplied: re.deleted };
  } finally {
    await check.end();
  }
}
