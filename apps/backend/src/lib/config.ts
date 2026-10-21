import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** Reads NAME, or the contents of the file at NAME_FILE (for secrets kept outside env). */
function secret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct) return direct;
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  return undefined;
}

const bool = z
  .string()
  .optional()
  .transform((v) => (v === undefined ? undefined : ['1', 'true', 'yes'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  ADMIN_PORT: z.coerce.number().int().default(3001),
  HOST: z.string().default('127.0.0.1'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),
  ADMIN_WEB_URL: z.string().url().default('http://localhost:5173'),
  ADMIN_STATIC_DIR: z.string().optional(),
  TRUST_PROXY: bool,
  COOKIE_SECURE: bool,
  MIN_APP_VERSION: z.string().default('0.1.0'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(465),
  SMTP_SECURE: bool,
  SMTP_USER: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().int().default(5432),
  DB_NAME: z.string().default('emailplatform'),
  DB_USER_OWNER: z.string().default('app_owner'),
  DB_USER_AUTH: z.string().default('app_auth'),
  DB_USER_API: z.string().default('app_api'),
  DB_USER_ADMIN: z.string().default('app_admin'),
  DB_USER_WORKER: z.string().default('app_worker'),
  DB_SSL: bool,
  HTTP_RATE_LIMIT: bool,
});

export type DbRole = 'owner' | 'auth' | 'api' | 'admin' | 'worker';

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  adminPort: number;
  host: string;
  publicApiUrl: string;
  adminWebUrl: string;
  adminStaticDir?: string;
  trustProxy: boolean;
  cookieSecure: boolean;
  minAppVersion: string;
  /** Per-IP request limits (in memory, per process). Login throttling in the database is always on. */
  httpRateLimit: boolean;
  smtp?: { host: string; port: number; secure: boolean; user?: string; password?: string; from: string };
  db: {
    host: string;
    port: number;
    database: string;
    ssl: boolean;
    users: Record<DbRole, string>;
    passwords: Partial<Record<DbRole, string>>;
  };
  jwtPrivateKeyPem?: string;
  credentialKey?: Buffer;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = schema.parse(env);
  const credentialKeyB64 = secret(env, 'CREDENTIAL_KEY');
  let credentialKey: Buffer | undefined;
  if (credentialKeyB64) {
    credentialKey = Buffer.from(credentialKeyB64, 'base64');
    if (credentialKey.length !== 32) throw new Error('CREDENTIAL_KEY must be 32 bytes, base64-encoded');
  }
  const cfg: Config = {
    env: e.NODE_ENV,
    port: e.PORT,
    adminPort: e.ADMIN_PORT,
    host: e.HOST,
    publicApiUrl: e.PUBLIC_API_URL.replace(/\/$/, ''),
    adminWebUrl: e.ADMIN_WEB_URL.replace(/\/$/, ''),
    adminStaticDir: e.ADMIN_STATIC_DIR,
    trustProxy: e.TRUST_PROXY ?? e.NODE_ENV === 'production',
    cookieSecure: e.COOKIE_SECURE ?? e.NODE_ENV === 'production',
    minAppVersion: e.MIN_APP_VERSION,
    httpRateLimit: e.HTTP_RATE_LIMIT ?? e.NODE_ENV !== 'test',
    smtp: e.SMTP_HOST
      ? {
          host: e.SMTP_HOST,
          port: e.SMTP_PORT,
          secure: e.SMTP_SECURE ?? e.SMTP_PORT === 465,
          user: e.SMTP_USER,
          password: secret(env, 'SMTP_PASSWORD'),
          from: e.SMTP_FROM ?? e.SMTP_USER ?? 'no-reply@localhost',
        }
      : undefined,
    db: {
      host: e.DB_HOST,
      port: e.DB_PORT,
      database: e.DB_NAME,
      ssl: e.DB_SSL ?? false,
      users: {
        owner: e.DB_USER_OWNER,
        auth: e.DB_USER_AUTH,
        api: e.DB_USER_API,
        admin: e.DB_USER_ADMIN,
        worker: e.DB_USER_WORKER,
      },
      passwords: {
        owner: secret(env, 'DB_PASSWORD_OWNER'),
        auth: secret(env, 'DB_PASSWORD_AUTH'),
        api: secret(env, 'DB_PASSWORD_API'),
        admin: secret(env, 'DB_PASSWORD_ADMIN'),
        worker: secret(env, 'DB_PASSWORD_WORKER'),
      },
    },
    jwtPrivateKeyPem: secret(env, 'JWT_PRIVATE_KEY'),
    credentialKey,
  };
  if (cfg.env === 'production') {
    const missing: string[] = [];
    if (!cfg.jwtPrivateKeyPem) missing.push('JWT_PRIVATE_KEY(_FILE)');
    if (!cfg.credentialKey) missing.push('CREDENTIAL_KEY(_FILE)');
    if (!cfg.smtp) missing.push('SMTP_HOST');
    if (missing.length) throw new Error(`Missing required production settings: ${missing.join(', ')}`);
  }
  return cfg;
}
