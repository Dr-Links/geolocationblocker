import { Queue, type ConnectionOptions } from "bullmq";

/** Queue names shared by the app (producer) and the worker (consumer). */
export const QUEUES = {
  system: "system",
  publish: "publish", // Phase 5
  generation: "generation", // Phase 3
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export function redisConnection(): ConnectionOptions {
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === "rediss:" ? {} : undefined,
    // Required by BullMQ for blocking commands.
    maxRetriesPerRequest: null,
  };
}

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: redisConnection() });
    queues.set(name, q);
  }
  return q;
}
