import IORedis from "ioredis";

const globalForRedis = globalThis as unknown as { redis?: IORedis };

/** Shared ioredis client for app-side use (rate limits, caches). BullMQ uses its own connections. */
export function getRedis(): IORedis {
  if (!globalForRedis.redis) {
    globalForRedis.redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      // Queue commands while (re)connecting, but bound how long a caller can wait,
      // so a Redis outage degrades quickly instead of hanging requests.
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      commandTimeout: 1_000,
    });
    globalForRedis.redis.on("error", () => {}); // surfaced per-command instead
  }
  return globalForRedis.redis;
}
