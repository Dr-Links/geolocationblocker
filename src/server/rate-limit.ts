import { getRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { RateLimitError } from "@/server/errors";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

/**
 * Fixed-window counter in Redis. Fails OPEN (allows) if Redis is unreachable,
 * logging a warning — availability over strictness for auth endpoints.
 */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
  const redisKey = `rl:${key}`;
  try {
    const redis = getRedis();
    const [[, count], [, ttl]] = (await redis.multi().incr(redisKey).ttl(redisKey).exec()) as [[null, number], [null, number]];
    if (ttl < 0) await redis.expire(redisKey, windowSec);
    const retryAfterSec = ttl > 0 ? ttl : windowSec;
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfterSec };
  } catch (err) {
    logger.warn({ err, key }, "rate limiter unavailable; allowing request");
    return { allowed: true, remaining: limit, retryAfterSec: 0 };
  }
}

export async function enforceRateLimit(key: string, limit: number, windowSec: number) {
  const r = await rateLimit(key, limit, windowSec);
  if (!r.allowed) throw new RateLimitError(r.retryAfterSec);
  return r;
}

export function envLimit(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
