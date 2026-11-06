import { headers } from "next/headers";

/**
 * Best-effort client IP. Assumes the app runs behind a trusted proxy that sets
 * X-Forwarded-For (Render/Fly/nginx do). Only the left-most entry is used.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

export async function userAgent(): Promise<string | null> {
  return (await headers()).get("user-agent");
}
