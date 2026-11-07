import { createHash, randomBytes } from "node:crypto";
import type { SocialPlatform } from "@prisma/client";
import { PublishError } from "./types";

/** PKCE (RFC 7636) S256 pair. */
export function pkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export type FetchLike = typeof fetch;

/**
 * JSON HTTP helper for platform APIs: consistent error mapping.
 * 401/403 → authExpired (reconnect needed); 429/5xx/network → retryable.
 */
export async function httpJson<T>(
  platform: SocialPlatform,
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit & { form?: Record<string, string>; json?: unknown } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.form) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(init.form).toString();
  } else if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, headers, body, signal: init.signal ?? AbortSignal.timeout(60_000) });
  } catch (err) {
    throw new PublishError(`${platform}: network error (${(err as Error).message})`, platform, { retryable: true, code: "network" });
  }
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const msg = extractMessage(data) ?? `HTTP ${res.status}`;
    throw new PublishError(`${platform}: ${msg}`.slice(0, 400), platform, {
      retryable: res.status === 429 || res.status >= 500,
      authExpired: res.status === 401,
      status: res.status,
      code: String(res.status),
    });
  }
  return data as T;
}

function extractMessage(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return typeof data === "string" && data ? data.slice(0, 200) : undefined;
  const d = data as Record<string, unknown>;
  const e = d.error as Record<string, unknown> | string | undefined;
  if (typeof e === "string") return (d.error_description as string) ?? e;
  return (e?.message as string) ?? (d.detail as string) ?? (d.message as string) ?? (d.title as string) ?? undefined;
}

export const expiresAt = (seconds: number | undefined | null) => (seconds ? new Date(Date.now() + seconds * 1000) : null);
