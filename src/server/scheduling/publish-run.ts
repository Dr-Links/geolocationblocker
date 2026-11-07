import type { PostStatus } from "@prisma/client";
import { systemDb, withTenantTx } from "@/lib/db";
import { logger } from "@/lib/logger";
import { nextOccurrence } from "@/lib/recurrence";
import { assertWithinLimit } from "@/server/billing/entitlements";
import { recordAudit } from "@/server/services/audit";
import { ensureFreshCredentials, loadPublishMedia } from "@/server/social/accounts";
import { publisherForAccount } from "@/server/social/registry";
import { PublishError } from "@/server/social/types";
import { textFor } from "./posts";
import { enqueuePublish } from "./queue";

/**
 * Worker side of the scheduler. Safe against duplicate/concurrent jobs:
 *   - the post is claimed SCHEDULED → PUBLISHING with a conditional update;
 *   - each target is claimed PENDING → PUBLISHING the same way, so no target
 *     is ever sent to a platform twice by two workers.
 */

export const MAX_ATTEMPTS = 4;
const STUCK_MS = 15 * 60_000;

/** Backoff after the n-th failed attempt: 1×, 5×, 15× the base (default 1 minute). */
export function backoffMs(attempt: number) {
  const base = Number(process.env.PUBLISH_RETRY_BASE_MS ?? 60_000);
  return base * ([1, 5, 15][attempt - 1] ?? 15);
}

export type RunResult = { postId: string; status: PostStatus | "SKIPPED"; published: number; failed: number; pending: number };

export async function processPublishJob(postId: string, now = new Date()): Promise<RunResult> {
  // 1. Claim the post if it's due.
  await systemDb.post.updateMany({ where: { id: postId, status: "SCHEDULED", schedule: { scheduledAt: { lte: now } } }, data: { status: "PUBLISHING" } });
  const post = await systemDb.post.findUnique({
    where: { id: postId },
    include: { schedule: true, targets: { include: { socialAccount: true } }, media: { orderBy: { order: "asc" } } },
  });
  if (!post || post.status !== "PUBLISHING") return { postId, status: "SKIPPED", published: 0, failed: 0, pending: 0 };

  // Suspended workspaces don't publish. Fail clearly rather than posting late after reinstatement.
  const ws = await systemDb.workspace.findUnique({ where: { id: post.workspaceId }, select: { suspendedAt: true } });
  if (ws?.suspendedAt) {
    await systemDb.postTarget.updateMany({
      where: { postId, status: "PENDING" },
      data: { status: "FAILED", lastError: "Not published: the workspace was suspended at the scheduled time.", nextAttemptAt: null },
    });
    return finalize(postId, now);
  }

  // 2. Publish each due target.
  const media = await withTenantTx(post.workspaceId, (tx) => loadPublishMedia(tx, post.media.map((m) => m.mediaAssetId)));
  for (const target of post.targets) {
    if (target.status !== "PENDING" || (target.nextAttemptAt && target.nextAttemptAt > now)) continue;
    const claimed = await systemDb.postTarget.updateMany({
      where: { id: target.id, status: "PENDING" },
      data: { status: "PUBLISHING", lastAttemptAt: now, attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) continue;
    const attempt = target.attempts + 1;
    const account = target.socialAccount;

    try {
      // Refresh inside the tenant tx; on failure the status write is committed before we rethrow.
      const creds = await withTenantTx(post.workspaceId, async (tx) => {
        try {
          return { ok: true as const, creds: await ensureFreshCredentials(tx, account) };
        } catch (err) {
          return { ok: false as const, err };
        }
      });
      if (!creds.ok) throw creds.err;
      const result = await publisherForAccount(account).publish({ text: textFor(post, account.platform), media }, creds.creds);
      await systemDb.postTarget.update({
        where: { id: target.id },
        data: { status: "PUBLISHED", externalPostId: result.externalPostId, externalUrl: result.url ?? null, publishedAt: new Date(), lastError: null, nextAttemptAt: null },
      });
      logger.info({ postId, targetId: target.id, platform: account.platform, externalPostId: result.externalPostId }, "published");
    } catch (err) {
      const pe = err instanceof PublishError ? err : new PublishError((err as Error).message ?? "Unknown error", account.platform, { retryable: true });
      const retry = pe.retryable && !pe.opts.authExpired && attempt < MAX_ATTEMPTS;
      let message = pe.message.slice(0, 500);
      if (pe.opts.authExpired) {
        message = `${account.handle ?? account.displayName}: access expired. Reconnect the account, then retry.`;
        await systemDb.socialAccount.updateMany({ where: { id: account.id, status: { not: "DISCONNECTED" } }, data: { status: "EXPIRED", lastError: pe.message.slice(0, 500) } });
      }
      await systemDb.postTarget.update({
        where: { id: target.id },
        data: retry
          ? { status: "PENDING", lastError: `Attempt ${attempt} failed: ${message}`, nextAttemptAt: new Date(now.getTime() + backoffMs(attempt)) }
          : { status: "FAILED", lastError: message, nextAttemptAt: null },
      });
      logger.warn({ postId, targetId: target.id, platform: account.platform, attempt, retry, err: pe.message }, "publish attempt failed");
    }
  }

  return finalize(postId, now);
}

/** Decide the post's status from its targets; schedule retries; continue recurring series. */
async function finalize(postId: string, now: Date): Promise<RunResult> {
  const post = await systemDb.post.findUniqueOrThrow({ where: { id: postId }, include: { targets: true, schedule: true, media: true } });
  const by = (s: string) => post.targets.filter((t) => t.status === s);
  const published = by("PUBLISHED").length;
  const failed = by("FAILED").length;
  const pendingTargets = by("PENDING");
  const inFlight = by("PUBLISHING").length;

  if (pendingTargets.length || inFlight) {
    const next = pendingTargets.map((t) => t.nextAttemptAt?.getTime() ?? now.getTime()).sort((a, b) => a - b)[0];
    if (next !== undefined) await enqueuePublish(postId, new Date(next), "r");
    return { postId, status: "PUBLISHING", published, failed, pending: pendingTargets.length + inFlight };
  }

  const status: PostStatus = failed === 0 ? "PUBLISHED" : published === 0 ? "FAILED" : "PARTIALLY_PUBLISHED";
  const firstPublish = post.targets.map((t) => t.publishedAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0];
  const { count } = await systemDb.post.updateMany({ where: { id: postId, status: "PUBLISHING" }, data: { status, publishedAt: firstPublish ?? null } });
  if (count) {
    await recordAudit({ action: `post.${status.toLowerCase()}`, workspaceId: post.workspaceId, targetType: "Post", targetId: postId, metadata: { published, failed } });
    if (post.schedule?.recurrenceRule) await scheduleNextOccurrence(post.id);
  }
  return { postId, status, published, failed, pending: 0 };
}

/** Create the next post in a recurring series (idempotent: one per occurrence time). */
export async function scheduleNextOccurrence(postId: string) {
  const post = await systemDb.post.findUniqueOrThrow({ where: { id: postId }, include: { schedule: true, targets: { include: { socialAccount: true } }, media: true } });
  const s = post.schedule;
  if (!s?.recurrenceRule) return null;
  let next = nextOccurrence(s.scheduledAt, s.recurrenceRule, s.timezone);
  // Skip occurrences already in the past (e.g. after downtime) instead of bursting.
  while (next && next.getTime() < Date.now() - 60_000) next = nextOccurrence(next, s.recurrenceRule, s.timezone);
  if (!next) return null;
  const seriesId = post.seriesId ?? post.id;

  const created = await withTenantTx(post.workspaceId, async (tx) => {
    const exists = await tx.post.findFirst({ where: { seriesId, schedule: { scheduledAt: next! } }, select: { id: true } });
    if (exists) return null;
    try {
      await assertWithinLimit(tx, post.workspaceId, "maxPostsPerMonth");
    } catch (err) {
      await recordAudit({ action: "post.series_paused", workspaceId: post.workspaceId, targetType: "Post", targetId: post.id, metadata: { reason: (err as Error).message } }, tx);
      return null;
    }
    const liveTargets = post.targets.filter((t) => t.socialAccount.status !== "DISCONNECTED");
    return tx.post.create({
      data: {
        workspaceId: post.workspaceId,
        authorId: post.authorId,
        content: post.content,
        platformOverrides: post.platformOverrides ?? {},
        status: "SCHEDULED",
        seriesId,
        schedule: { create: { scheduledAt: next!, timezone: s.timezone, recurrenceRule: s.recurrenceRule } },
        targets: { create: liveTargets.map((t) => ({ socialAccountId: t.socialAccountId })) },
        media: { create: post.media.map((m) => ({ mediaAssetId: m.mediaAssetId, order: m.order })) },
      },
    });
  });
  if (created) await enqueuePublish(created.id, next);
  return created;
}

/**
 * Every minute (worker): re-enqueue due posts (in case a delayed job was lost),
 * pick up due retries, and resolve targets stuck mid-publish by a crashed worker.
 * Stuck targets become FAILED (not retried automatically): the platform may have
 * received the post, and a blind retry could double-post.
 */
export async function sweepDuePosts(now = new Date()) {
  const bucket = Math.floor(now.getTime() / 60_000) * 60_000;
  const due = await systemDb.post.findMany({ where: { status: "SCHEDULED", schedule: { scheduledAt: { lte: now } } }, select: { id: true }, take: 500 });
  const retries = await systemDb.post.findMany({
    where: { status: "PUBLISHING", targets: { some: { status: "PENDING", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] } } },
    select: { id: true },
    take: 500,
  });
  const stuck = await systemDb.postTarget.findMany({ where: { status: "PUBLISHING", lastAttemptAt: { lt: new Date(now.getTime() - STUCK_MS) } }, select: { id: true, postId: true } });
  for (const t of stuck) {
    await systemDb.postTarget.updateMany({
      where: { id: t.id, status: "PUBLISHING" },
      data: { status: "FAILED", lastError: "Publishing was interrupted. Check the platform before retrying, to avoid a duplicate post." },
    });
  }
  const ids = new Set([...due.map((p) => p.id), ...retries.map((p) => p.id), ...stuck.map((t) => t.postId)]);
  for (const id of ids) await enqueuePublish(id, new Date(bucket), "w");
  return { due: due.length, retries: retries.length, stuck: stuck.length };
}
