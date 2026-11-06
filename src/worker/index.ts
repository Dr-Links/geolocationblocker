/**
 * Background worker (separate process): `npm run worker`.
 * Phase 0: boots BullMQ consumers + a heartbeat job so we can prove the pipeline works.
 * Phase 3 adds the generation processor; Phase 5 adds the publish/scheduler processor.
 */

import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { QUEUES, getQueue, redisConnection } from "@/lib/queues";

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
  const workers = [systemWorker];

  for (const w of workers) {
    w.on("completed", (job) => logger.debug({ queue: w.name, jobId: job.id, name: job.name }, "job completed"));
    w.on("failed", (job, err) =>
      logger.error({ queue: w.name, jobId: job?.id, name: job?.name, attempts: job?.attemptsMade, err }, "job failed"),
    );
    w.on("error", (err) => logger.error({ queue: w.name, err }, "worker error"));
  }

  // Repeatable heartbeat every minute (idempotent: same scheduler id on every boot).
  await getQueue(QUEUES.system).upsertJobScheduler("heartbeat", { every: 60_000 }, { name: "heartbeat" });

  logger.info({ queues: workers.map((w) => w.name) }, "worker started");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "worker shutting down");
    await Promise.allSettled(workers.map((w) => w.close()));
    await getQueue(QUEUES.system).close();
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
