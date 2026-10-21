import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(input: string | Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const VERSION = 1;

/** AES-256-GCM. Output: version(1) | iv(12) | tag(16) | ciphertext. `aad` binds the ciphertext to its row. */
export function encryptSecret(key: Buffer, plaintext: string, aad: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

export function decryptSecret(key: Buffer, blob: Buffer, aad: string): string {
  if (blob[0] !== VERSION) throw new Error('unsupported ciphertext version');
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const ct = blob.subarray(29);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
