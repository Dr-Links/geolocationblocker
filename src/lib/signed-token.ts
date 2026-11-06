import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Compact HMAC-signed, expiring tokens (base64url(JSON).base64url(sig)).
 * Used for mock-billing links so their parameters can't be tampered with.
 */
function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return s;
}

const sign = (data: string, purpose: string) => createHmac("sha256", secret()).update(`${purpose}.${data}`).digest("base64url");

export function signToken<T extends object>(payload: T, purpose: string, ttlSeconds: number): string {
  const data = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  return `${data}.${sign(data, purpose)}`;
}

export function verifyToken<T extends object>(token: string | undefined | null, purpose: string): T | null {
  if (!token || token.length > 4096) return null;
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = Buffer.from(sign(data, purpose));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as T & { exp: number };
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
