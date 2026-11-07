import { QUEUES, getQueue } from "@/lib/queues";

/**
 * BullMQ is the timer, not the source of truth: every job only says "look at
 * post X now". The DB state + atomic claims decide what actually happens, so
 * duplicate, early or late jobs are harmless. A once-a-minute sweep re-enqueues
 * anything due, in case Redis lost a delayed job.
 */
export async function enqueuePublish(postId: string, at: Date, tag = "s") {
  const delay = Math.max(0, at.getTime() - Date.now());
  await getQueue(QUEUES.publish).add(
    "publish",
    { postId },
    {
      jobId: `${postId}-${tag}-${at.getTime()}`, // BullMQ dedupes identical ids
      delay,
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: 2000,
      removeOnFail: 5000,
    },
  );
}

/** Best-effort removal of not-yet-run delayed jobs (the DB state already makes them no-ops). */
export async function cancelPublishJobs(postId: string) {
  try {
    const q = getQueue(QUEUES.publish);
    const jobs = await q.getJobs(["delayed", "waiting"], 0, 500);
    await Promise.all(jobs.filter((j) => j.data?.postId === postId).map((j) => j.remove().catch(() => {})));
  } catch {
    /* Redis unavailable: harmless, the job will see the post isn't due */
  }
}
