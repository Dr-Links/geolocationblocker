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
  const workers = [systemWorker, generationWorker];

  for (const w of workers) {
    w.on("completed", (job) => logger.debug({ queue: w.name, jobId: job.id, name: job.name }, "job completed"));
    w.on("failed", (job, err) =>
      logger.error({ queue: w.name, jobId: job?.id, name: job?.name, attempts: job?.attemptsMade, err }, "job failed"),
    );
    w.on("error", (err) => logger.error({ queue: w.name, err }, "worker error"));
  }

  // Repeatable heartbeat every minute (idempotent: same scheduler id on every boot).
  await getQueue(QUEUES.system).upsertJobScheduler("heartbeat", { every: 60_000 }, { name: "heartbeat" });

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
    await Promise.allSettled([getQueue(QUEUES.system).close(), getQueue(QUEUES.generation).close()]);
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
