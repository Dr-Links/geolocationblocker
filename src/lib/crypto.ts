import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope for secrets at rest (OAuth tokens, BYOK API keys).
 * Format: "v1.<iv b64url>.<tag b64url>.<ciphertext b64url>"
 * Decrypt tries ENCRYPTION_KEY, then ENCRYPTION_KEY_PREVIOUS (key rotation).
 */
const VERSION = "v1";
const IV_BYTES = 12;

function parseKey(raw: string | undefined, name: string): Buffer {
  if (!raw) throw new Error(`${name} is not set`);
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes base64-encoded (got ${key.length} bytes)`);
  return key;
}

function keys(): Buffer[] {
  const out = [parseKey(process.env.ENCRYPTION_KEY, "ENCRYPTION_KEY")];
  if (process.env.ENCRYPTION_KEY_PREVIOUS) {
    out.push(parseKey(process.env.ENCRYPTION_KEY_PREVIOUS, "ENCRYPTION_KEY_PREVIOUS"));
  }
  return out;
}

export function encryptSecret(plaintext: string): string {
  const [key] = keys();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key!, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("Unrecognized encrypted payload format");
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const ct = Buffer.from(ctB64, "base64url");

  let lastErr: unknown;
  for (const key of keys()) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error("Failed to decrypt secret", { cause: lastErr });
}
