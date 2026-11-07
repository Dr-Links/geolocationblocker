import { systemDb } from "@/lib/db";
import { QUEUES, getQueue } from "@/lib/queues";

/** Publishing & worker operations view (cross-tenant, SUPER_ADMIN only). */

export async function getOpsOverview(days = 7) {
  const since = new Date(Date.now() - days * 86_400_000);
  const [failedTargets, accountStatus, unhealthyAccounts, stuckPublishing, failedGenerations] = await Promise.all([
    systemDb.postTarget.findMany({
      where: { status: "FAILED", updatedAt: { gte: since } },
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: {
        socialAccount: { select: { platform: true, handle: true, displayName: true, isMock: true } },
        post: { select: { id: true, content: true, workspace: { select: { id: true, name: true } } } },
      },
    }),
    systemDb.socialAccount.groupBy({ by: ["status"], _count: { _all: true } }),
    systemDb.socialAccount.findMany({
      where: { status: { in: ["EXPIRED", "ERROR"] } },
      orderBy: { updatedAt: "desc" },
      take: 50,
      include: { workspace: { select: { id: true, name: true } } },
    }),
    systemDb.post.count({ where: { status: "PUBLISHING" } }),
    systemDb.generationRequest.count({ where: { status: "FAILED", createdAt: { gte: since } } }),
  ]);
  const queues = await Promise.all(
    [QUEUES.publish, QUEUES.generation, QUEUES.system].map(async (name) => {
      try {
        const c = await getQueue(name).getJobCounts("waiting", "delayed", "active", "failed", "completed");
        return { name, ...c, ok: true };
      } catch {
        return { name, waiting: 0, delayed: 0, active: 0, failed: 0, completed: 0, ok: false };
      }
    }),
  );
  return { failedTargets, accountStatus, unhealthyAccounts, stuckPublishing, failedGenerations, queues, days };
}
