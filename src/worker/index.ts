/**
 * Background worker (separate process): `npm run worker`.
 * Phase 0: boots BullMQ consumers + a heartbeat job so we can prove the pipeline works.
 * Phase 3 adds the generation processor; Phase 5 adds the publish/scheduler processor.
 */

import { createServer } from "node:http";
import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { QUEUES, getQueue, redisConnection } from "@/lib/queues";
import { processGeneration } from "@/server/ai/service";
import { refreshExpiringTokens } from "@/server/social/accounts";
import { processPublishJob, sweepDuePosts } from "@/server/scheduling/publish-run";

const HEARTBEAT_KEY = "worker:heartbeat";

async function processSystemJob(job: Job) {
  switch (job.name) {
    case "heartbeat": {
      const redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
      try {
        await redis.set(HEARTBEAT_KEY, new Date().toISOString(), "EX", 180);
      } finally {
        redis.disconnect();
      }
      return { ok: true };
    }
    case "publish-sweep": {
      const r = await sweepDuePosts();
      if (r.due || r.retries || r.stuck) logger.info(r, "publish sweep");
      return r;
    }
    case "social-token-refresh": {
      const r = await refreshExpiringTokens();
      if (r.checked) logger.info(r, "social token refresh sweep");
      return r;
    }
    default:
      throw new Error(`Unknown system job: ${job.name}`);
  }
}

async function main() {
  getEnv(); // fail fast on missing/invalid config
  const connection = redisConnection();

  const systemWorker = new Worker(QUEUES.system, processSystemJob, { connection, concurrency: 1 });
  // AI generation: video jobs can run for minutes; BullMQ renews the lock while the job runs.
  const generationWorker = new Worker(
    QUEUES.generation,
    async (job: Job<{ id: string }>) => {
      const r = await processGeneration(job.data.id);
      return { status: r.status };
    },
    { connection, concurrency: Number(process.env.AI_WORKER_CONCURRENCY ?? 4), lockDuration: 120_000 },
  );
  // Scheduled publishing: each job only says "look at post X"; DB claims decide what happens.
  const publishWorker = new Worker(
    QUEUES.publish,
    async (job: Job<{ postId: string }>) => processPublishJob(job.data.postId),
    { connection, concurrency: Number(process.env.PUBLISH_WORKER_CONCURRENCY ?? 5), lockDuration: 120_000 },
  );
  const workers = [systemWorker, generationWorker, publishWorker];

  for (const w of workers) {
    w.on("completed", (job) => logger.debug({ queue: w.name, jobId: job.id, name: job.name }, "job completed"));
    w.on("failed", (job, err) =>
      logger.error({ queue: w.name, jobId: job?.id, name: job?.name, attempts: job?.attemptsMade, err }, "job failed"),
    );
    w.on("error", (err) => logger.error({ queue: w.name, err }, "worker error"));
  }

  // Repeatable heartbeat every minute (idempotent: same scheduler id on every boot).
  await getQueue(QUEUES.system).upsertJobScheduler("heartbeat", { every: 60_000 }, { name: "heartbeat" });
  // Safety net for scheduled posts (lost delayed jobs, due retries, crashed workers).
  await getQueue(QUEUES.system).upsertJobScheduler("publish-sweep", { every: 60_000 }, { name: "publish-sweep" });
  // Refresh social tokens expiring within 24h, so scheduled posts don't hit expired tokens.
  await getQueue(QUEUES.system).upsertJobScheduler("social-token-refresh", { every: 30 * 60_000 }, { name: "social-token-refresh" });

  // Optional health endpoint for orchestrators (Docker/Fly/Render) and e2e tests.
  const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? 0);
  const health = healthPort
    ? createServer((_req, res) => {
        const ok = workers.every((w) => w.isRunning());
        res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" }).end(JSON.stringify({ ok, queues: workers.map((w) => w.name) }));
      }).listen(healthPort)
    : null;

  logger.info({ queues: workers.map((w) => w.name), healthPort: healthPort || undefined }, "worker started");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "worker shutting down");
    health?.close();
    await Promise.allSettled(workers.map((w) => w.close()));
    await Promise.allSettled([getQueue(QUEUES.system).close(), getQueue(QUEUES.generation).close(), getQueue(QUEUES.publish).close()]);
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
