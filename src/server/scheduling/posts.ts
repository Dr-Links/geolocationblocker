import type { Prisma, SocialPlatform } from "@prisma/client";
import { z } from "zod";
import { withTenantTx, type Tx } from "@/lib/db";
import { formatRule, parseRule, DAY_CODES } from "@/lib/recurrence";
import { isValidTimezone, localToUtc } from "@/lib/time";
import { assertFeature, assertWithinLimit } from "@/server/billing/entitlements";
import { ConflictError, NotFoundError } from "@/server/errors";
import { enforceRateLimit, envLimit } from "@/server/rate-limit";
import { auditActor, recordAudit } from "@/server/services/audit";
import { loadPublishMedia } from "@/server/social/accounts";
import { publisherForAccount } from "@/server/social/registry";
import type { ValidationResult } from "@/server/social/types";
import { assertCan } from "@/server/tenancy/guard";
import type { TenantContext } from "@/server/tenancy/types";
import { cancelPublishJobs, enqueuePublish } from "./queue";
import { nextFreeSlot, parseSlots, slotsSchema } from "./queue-slots";

/**
 * Post lifecycle:
 *   DRAFT ──schedule──▶ SCHEDULED ──(due, worker claims)──▶ PUBLISHING ──▶ PUBLISHED | PARTIALLY_PUBLISHED | FAILED
 *   SCHEDULED ──unschedule──▶ DRAFT          FAILED/PARTIAL ──retry──▶ SCHEDULED (failed targets only)
 */

const EDITABLE = new Set(["DRAFT", "SCHEDULED", "FAILED"]);
const id = z.string().min(8).max(64);

export const overridesSchema = z.record(z.string(), z.object({ content: z.string().max(70_000) })).default({});

export const savePostSchema = z.object({
  postId: id.optional(),
  content: z.string().max(70_000).default(""),
  platformOverrides: overridesSchema,
  mediaAssetIds: z.array(id).max(20).default([]),
  accountIds: z.array(id).max(50).default([]),
});
export type SavePostInput = z.input<typeof savePostSchema>;

/** Text for one platform: its override if set, else the shared content. */
export function textFor(post: { content: string; platformOverrides: unknown }, platform: SocialPlatform) {
  const o = (post.platformOverrides ?? {}) as Record<string, { content?: string }>;
  const v = o[platform]?.content;
  return typeof v === "string" && v.trim() ? v : post.content;
}

/** Create or update a post's content, media and target accounts (status unchanged; new posts are drafts). */
export async function savePost(ctx: TenantContext, input: SavePostInput) {
  assertCan(ctx, "content.create");
  const data = savePostSchema.parse(input);
  const mediaIds = [...new Set(data.mediaAssetIds)];
  const accountIds = [...new Set(data.accountIds)];
  // Drop empty overrides.
  const overrides = Object.fromEntries(Object.entries(data.platformOverrides).filter(([, v]) => v.content.trim()));

  return withTenantTx(ctx.workspaceId, async (tx) => {
    if (mediaIds.length && (await tx.mediaAsset.count({ where: { id: { in: mediaIds } } })) !== mediaIds.length) throw new NotFoundError("Some attached media no longer exists");
    const accounts = await tx.socialAccount.findMany({ where: { id: { in: accountIds } } });
    if (accounts.length !== accountIds.length) throw new NotFoundError("Some selected accounts no longer exist");

    let postId = data.postId;
    if (postId) {
      const post = await tx.post.findUnique({ where: { id: postId } });
      if (!post) throw new NotFoundError("Post not found");
      if (!EDITABLE.has(post.status)) throw new ConflictError(`A ${post.status.toLowerCase().replace("_", " ")} post can't be edited.`);
      await tx.post.update({ where: { id: postId }, data: { content: data.content, platformOverrides: overrides } });
    } else {
      await assertWithinLimit(tx, ctx.workspaceId, "maxPostsPerMonth");
      postId = (await tx.post.create({ data: { workspaceId: ctx.workspaceId, authorId: ctx.userId, content: data.content, platformOverrides: overrides, status: "DRAFT" } })).id;
    }
    await tx.postMedia.deleteMany({ where: { postId } });
    if (mediaIds.length) await tx.postMedia.createMany({ data: mediaIds.map((mediaAssetId, order) => ({ postId: postId!, mediaAssetId, order })) });
    // Keep targets that already published; replace the rest.
    await tx.postTarget.deleteMany({ where: { postId, socialAccountId: { notIn: accountIds }, status: { not: "PUBLISHED" } } });
    for (const socialAccountId of accountIds) {
      await tx.postTarget.upsert({ where: { postId_socialAccountId: { postId, socialAccountId } }, update: {}, create: { postId, socialAccountId } });
    }
    return tx.post.findUniqueOrThrow({ where: { id: postId } });
  });
}

// ─── Scheduling ────────────────────────────────────────────────────────────

const recurrenceSchema = z
  .object({
    freq: z.enum(["DAILY", "WEEKLY", "MONTHLY"]),
    interval: z.coerce.number().int().min(1).max(52).default(1),
    byDay: z.array(z.enum(DAY_CODES)).max(7).optional(),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .optional()
  .nullable();

export const scheduleSchema = z.object({
  mode: z.enum(["now", "at", "queue"]),
  /** "YYYY-MM-DDTHH:mm" wall-clock time in `timezone` (mode "at"). */
  localDateTime: z.string().optional(),
  timezone: z.string().refine(isValidTimezone, "Unknown timezone").optional(),
  recurrence: recurrenceSchema,
});
export type ScheduleInput = z.input<typeof scheduleSchema>;

export interface TargetCheck extends ValidationResult {
  accountId: string;
  platform: SocialPlatform;
  label: string;
}

/** Validate every target with its own (possibly overridden) text and the attached media. */
async function checkTargets(tx: Tx, postId: string): Promise<TargetCheck[]> {
  const post = await tx.post.findUniqueOrThrow({
    where: { id: postId },
    include: { targets: { include: { socialAccount: true } }, media: { orderBy: { order: "asc" } } },
  });
  const media = await loadPublishMedia(tx, post.media.map((m) => m.mediaAssetId));
  return post.targets
    .filter((t) => t.status !== "PUBLISHED")
    .map((t) => {
      const a = t.socialAccount;
      const label = a.handle ?? a.displayName;
      if (a.status === "DISCONNECTED" || a.status === "EXPIRED") {
        return { accountId: a.id, platform: a.platform, label, ok: false, warnings: [], errors: [{ code: "account_unavailable", message: `${label} is ${a.status.toLowerCase()}; reconnect it first.` }] };
      }
      try {
        return { accountId: a.id, platform: a.platform, label, ...publisherForAccount(a).validateMedia({ text: textFor(post, a.platform), media }) };
      } catch (err) {
        return { accountId: a.id, platform: a.platform, label, ok: false, warnings: [], errors: [{ code: "publisher_unavailable", message: (err as Error).message }] };
      }
    });
}

/**
 * Schedule (or publish now, or add to the queue). Refuses if any target fails
 * validation, so problems surface in the composer, not at 3am in the worker.
 */
export async function schedulePost(ctx: TenantContext, postId: string, input: ScheduleInput) {
  assertCan(ctx, "content.publish");
  const data = scheduleSchema.parse(input);
  await enforceRateLimit(`publish:ws:${ctx.workspaceId}`, envLimit("RATE_LIMIT_SCHEDULE_PER_MIN", 30), 60);

  const result = await withTenantTx(ctx.workspaceId, async (tx) => {
    const post = await tx.post.findUnique({ where: { id: postId }, include: { targets: true, schedule: true } });
    if (!post) throw new NotFoundError("Post not found");
    if (post.status !== "DRAFT" && post.status !== "SCHEDULED") throw new ConflictError("Only drafts and scheduled posts can be (re)scheduled.");
    if (!post.targets.length) throw new ConflictError("Choose at least one account to publish to.");
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { timezone: true, queueSlots: true } });
    const tz = data.timezone ?? ws.timezone;

    const checks = await checkTargets(tx, postId);
    const failing = checks.filter((c) => !c.ok);
    if (failing.length) return { ok: false as const, checks };

    let scheduledAt: Date;
    const now = new Date();
    if (data.mode === "now") scheduledAt = now;
    else if (data.mode === "at") {
      const at = data.localDateTime ? localToUtc(data.localDateTime, tz) : null;
      if (!at) throw new ConflictError("Choose a valid date and time.");
      if (at.getTime() < now.getTime() - 60_000) throw new ConflictError("That time is in the past.");
      if (at.getTime() > now.getTime() + 366 * 86_400_000) throw new ConflictError("Schedule at most one year ahead.");
      scheduledAt = at;
    } else {
      const taken = await tx.postSchedule.findMany({ where: { post: { workspaceId: ctx.workspaceId, status: "SCHEDULED" }, scheduledAt: { gt: now } }, select: { scheduledAt: true } });
      const slot = nextFreeSlot(parseSlots(ws.queueSlots), tz, now, new Set(taken.map((t) => t.scheduledAt.getTime())));
      if (!slot) throw new ConflictError("Your queue has no free slots. Add posting times on the Calendar page.");
      scheduledAt = slot;
    }

    let recurrenceRule: string | null = null;
    if (data.recurrence) {
      await assertFeature(tx, ctx.workspaceId, "recurring");
      recurrenceRule = formatRule({ ...data.recurrence, interval: data.recurrence.interval ?? 1 });
      if (!parseRule(recurrenceRule)) throw new ConflictError("Invalid repeat settings.");
    }

    await tx.postSchedule.upsert({
      where: { postId },
      update: { scheduledAt, timezone: tz, recurrenceRule },
      create: { postId, scheduledAt, timezone: tz, recurrenceRule },
    });
    await tx.postTarget.updateMany({ where: { postId, status: { not: "PUBLISHED" } }, data: { status: "PENDING", attempts: 0, lastError: null, nextAttemptAt: null } });
    const updated = await tx.post.update({ where: { id: postId }, data: { status: "SCHEDULED", seriesId: recurrenceRule ? (post.seriesId ?? post.id) : post.seriesId } });
    await recordAudit(
      { action: data.mode === "now" ? "post.publish_now" : "post.schedule", ...auditActor(ctx), targetType: "Post", targetId: postId, metadata: { scheduledAt: scheduledAt.toISOString(), timezone: tz, recurrenceRule, mode: data.mode } },
      tx,
    );
    return { ok: true as const, post: updated, scheduledAt, checks };
  });

  if (result.ok) await enqueuePublish(postId, result.scheduledAt);
  return result;
}

export async function unschedulePost(ctx: TenantContext, postId: string) {
  assertCan(ctx, "content.publish");
  await withTenantTx(ctx.workspaceId, async (tx) => {
    // Conditional update: loses the race cleanly if the worker already claimed it.
    const { count } = await tx.post.updateMany({ where: { id: postId, status: "SCHEDULED" }, data: { status: "DRAFT" } });
    if (!count) throw new ConflictError("Only scheduled posts that haven't started publishing can be unscheduled.");
    await tx.postSchedule.deleteMany({ where: { postId } });
    await recordAudit({ action: "post.unschedule", ...auditActor(ctx), targetType: "Post", targetId: postId }, tx);
  });
  await cancelPublishJobs(postId);
}

/** Retry the targets that failed (others keep their published result). */
export async function retryFailedTargets(ctx: TenantContext, postId: string) {
  assertCan(ctx, "content.publish");
  await withTenantTx(ctx.workspaceId, async (tx) => {
    const post = await tx.post.findUnique({ where: { id: postId } });
    if (!post) throw new NotFoundError("Post not found");
    if (post.status !== "FAILED" && post.status !== "PARTIALLY_PUBLISHED") throw new ConflictError("Nothing to retry.");
    const { count } = await tx.postTarget.updateMany({ where: { postId, status: "FAILED" }, data: { status: "PENDING", attempts: 0, nextAttemptAt: null, lastError: null } });
    if (!count) throw new ConflictError("Nothing to retry.");
    const now = new Date();
    await tx.postSchedule.upsert({ where: { postId }, update: { scheduledAt: now }, create: { postId, scheduledAt: now, timezone: "UTC" } });
    await tx.post.update({ where: { id: postId }, data: { status: "SCHEDULED" } });
    await recordAudit({ action: "post.retry", ...auditActor(ctx), targetType: "Post", targetId: postId, metadata: { targets: count } }, tx);
  });
  await enqueuePublish(postId, new Date());
}

export async function deletePost(ctx: TenantContext, postId: string) {
  assertCan(ctx, "content.create");
  await withTenantTx(ctx.workspaceId, async (tx) => {
    const { count } = await tx.post.deleteMany({ where: { id: postId, status: { not: "PUBLISHING" } } });
    if (!count) throw new ConflictError("This post can't be deleted right now (it may be publishing).");
    await recordAudit({ action: "post.delete", ...auditActor(ctx), targetType: "Post", targetId: postId }, tx);
  });
  await cancelPublishJobs(postId);
}

// ─── Reads ─────────────────────────────────────────────────────────────────

const postInclude = {
  schedule: true,
  targets: { include: { socialAccount: { select: { id: true, platform: true, handle: true, displayName: true, status: true, isMock: true } } }, orderBy: { createdAt: "asc" } },
  media: { orderBy: { order: "asc" }, include: { mediaAsset: true } },
} satisfies Prisma.PostInclude;

export type PostWithRelations = Prisma.PostGetPayload<{ include: typeof postInclude }>;

export async function getPost(ctx: TenantContext, postId: string) {
  const post = await ctx.db.post.findUnique({ where: { id: postId }, include: postInclude });
  if (!post) throw new NotFoundError("Post not found");
  return post;
}

export async function listPosts(ctx: TenantContext, status: "DRAFT" | "SCHEDULED" | "PUBLISHED" | "FAILED" | "ALL", take = 50) {
  const where: Prisma.PostWhereInput =
    status === "ALL" ? {} : status === "PUBLISHED" ? { status: { in: ["PUBLISHED", "PARTIALLY_PUBLISHED"] } } : status === "SCHEDULED" ? { status: { in: ["SCHEDULED", "PUBLISHING"] } } : status === "FAILED" ? { status: { in: ["FAILED", "PARTIALLY_PUBLISHED"] } } : { status };
  return ctx.db.post.findMany({
    where: { workspaceId: ctx.workspaceId, ...where },
    include: postInclude,
    orderBy: status === "SCHEDULED" ? [{ schedule: { scheduledAt: "asc" } }] : [{ updatedAt: "desc" }],
    take,
  });
}

/** Posts scheduled or published in [from, to) for the calendar. */
export async function listCalendar(ctx: TenantContext, from: Date, to: Date) {
  return ctx.db.post.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      OR: [{ schedule: { scheduledAt: { gte: from, lt: to } } }, { publishedAt: { gte: from, lt: to } }],
    },
    include: postInclude,
    orderBy: { createdAt: "asc" },
  });
}

export async function updateQueueSlots(ctx: TenantContext, raw: unknown) {
  assertCan(ctx, "workspace.update");
  const slots = parseSlots(slotsSchema.parse(raw));
  await withTenantTx(ctx.workspaceId, async (tx) => {
    await tx.workspace.update({ where: { id: ctx.workspaceId }, data: { queueSlots: slots } });
    await recordAudit({ action: "workspace.queue_slots", ...auditActor(ctx), metadata: { slots } }, tx);
  });
  return slots;
}
