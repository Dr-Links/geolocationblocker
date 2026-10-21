import { randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import type { Config } from '../lib/config.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import type { Tx } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';

const ISSUER = 'Email Platform Admin';
const PERIOD = 30;

function totp(secretB32: string, label: string) {
  return new OTPAuth.TOTP({ issuer: ISSUER, label, algorithm: 'SHA1', digits: 6, period: PERIOD, secret: OTPAuth.Secret.fromBase32(secretB32) });
}

export function credentialKey(cfg: Config): Buffer {
  if (cfg.credentialKey) return cfg.credentialKey;
  if (cfg.env === 'production') throw new Error('CREDENTIAL_KEY is required');
  // Development/test fallback: fixed, obviously-not-secret key.
  return Buffer.alloc(32, 7);
}

function recoveryCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export interface Enrollment {
  secret: string;
  otpauthUri: string;
  recoveryCodes: string[];
}

/** Replaces all second factors of the admin with a new TOTP secret and 10 recovery codes. */
export async function enrollMfa(c: Tx, cfg: Config, userId: string, label: string): Promise<Enrollment> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const codes = Array.from({ length: 10 }, recoveryCode);
  await c.query(`DELETE FROM mfa_factors WHERE user_id = $1`, [userId]);
  await c.query(`INSERT INTO mfa_factors (user_id, kind, secret_enc) VALUES ($1, 'totp', $2)`,
    [userId, encryptSecret(credentialKey(cfg), secret, `totp:${userId}`)]);
  for (const code of codes) {
    await c.query(`INSERT INTO mfa_factors (user_id, kind, code_hash) VALUES ($1, 'recovery_code', $2)`,
      [userId, await hashPassword(code.replace(/-/g, ''))]);
  }
  return { secret, otpauthUri: totp(secret, label).toString(), recoveryCodes: codes };
}

/** Checks a TOTP code (with replay protection) or a single-use recovery code. */
export async function verifySecondFactor(c: Tx, cfg: Config, userId: string, input: { code?: string; recoveryCode?: string }): Promise<'totp' | 'recovery_code'> {
  if (input.code) {
    const { rows } = await c.query<{ id: string; secret_enc: Buffer; last_used_step: number | null }>(
      `SELECT id, secret_enc, last_used_step FROM mfa_factors WHERE user_id = $1 AND kind = 'totp' FOR UPDATE`, [userId]);
    const f = rows[0];
    if (f) {
      const secret = decryptSecret(credentialKey(cfg), f.secret_enc, `totp:${userId}`);
      const delta = totp(secret, 'admin').validate({ token: input.code.replace(/\s/g, ''), window: 1 });
      if (delta !== null) {
        const step = Math.floor(Date.now() / 1000 / PERIOD) + delta;
        if (f.last_used_step === null || step > f.last_used_step) {
          await c.query(`UPDATE mfa_factors SET last_used_step = $2, used_at = now() WHERE id = $1`, [f.id, step]);
          return 'totp';
        }
      }
    }
  } else if (input.recoveryCode) {
    const normalized = input.recoveryCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const { rows } = await c.query<{ id: string; code_hash: string }>(
      `SELECT id, code_hash FROM mfa_factors WHERE user_id = $1 AND kind = 'recovery_code' AND used_at IS NULL FOR UPDATE`, [userId]);
    for (const r of rows) {
      if (await verifyPassword(r.code_hash, normalized)) {
        await c.query(`UPDATE mfa_factors SET used_at = now() WHERE id = $1`, [r.id]);
        return 'recovery_code';
      }
    }
  }
  throw new AppError(401, 'invalid_mfa_code', 'The authenticator or recovery code is not valid.');
}
