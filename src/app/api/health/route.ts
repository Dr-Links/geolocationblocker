import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getRedis } from "@/lib/redis";

export const dynamic = "force-dynamic";

const withTimeout = <T,>(p: Promise<T>, ms = 2000) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

/**
 * Liveness/readiness for load balancers. The database is required (503 if
 * down). Redis is reported but doesn't fail the check: pages still serve
 * without it, and rate limits fail open, while scheduling waits for the worker.
 */
export async function GET() {
  const [dbOk, redisOk] = await Promise.all([
    withTimeout(db.$queryRaw`SELECT 1`).then(() => true, () => false),
    withTimeout(getRedis().ping()).then(() => true, () => false),
  ]);
  return NextResponse.json(
    { status: dbOk ? (redisOk ? "ok" : "degraded") : "down", db: dbOk ? "ok" : "error", redis: redisOk ? "ok" : "error" },
    { status: dbOk ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
