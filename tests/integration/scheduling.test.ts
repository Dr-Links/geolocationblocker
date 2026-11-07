import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "@/lib/crypto";
import { db, systemDb, tenantDb } from "@/lib/db";
import { QUEUES, getQueue } from "@/lib/queues";
import { localToUtc, utcToLocalInput } from "@/lib/time";
import { compWorkspace } from "@/server/billing/comp";
import { ConflictError, LimitExceededError, NotFoundError } from "@/server/errors";
import { MAX_ATTEMPTS, backoffMs, processPublishJob, sweepDuePosts } from "@/server/scheduling/publish-run";
import { retryFailedTargets, savePost, schedulePost, unschedulePost, updateQueueSlots } from "@/server/scheduling/posts";
import { MockPublisher } from "@/server/social/publishers/mock";
import { cleanupTestData, ctxFor, makeTenant, testEmail } from "./fixtures";

process.env.MOCK_PUBLISH_DELAY_MS = "0";
const MIN = 60_000;
let adminId: string;

async function tenant(label: string, opts: { recurring?: boolean } = {}) {
  const t = await makeTenant(label);
  const plan = await systemDb.plan.upsert({
    where: { key: "itest-sched" },
    update: {},
    create: { key: "itest-sched", name: "Sched", maxPostsPerMonth: -1, monthlyCredits: 10, maxSocialAccounts: -1, maxMembers: -1, features: { recurring: true } },
  });
  if (opts.recurring) await compWorkspace(adminId, t.workspace.id, { planId: plan.id, reason: "scheduling tests" });
  await tenantDb(t.workspace.id).workspace.update({ where: { id: t.workspace.id }, data: { timezone: "America/New_York" } });
  const linkedin = await tenantDb(t.workspace.id).socialAccount.create({
    data: { workspaceId: t.workspace.id, platform: "LINKEDIN", isMock: true, externalId: `li-${label}`, displayName: `${label} on LinkedIn`, accessTokenEnc: encryptSecret("t") },
  });
  return { ...t, linkedin, ctx: ctxFor(t.admin.id, t.workspace.id, "WORKSPACE_ADMIN") };
}

type T = Awaited<ReturnType<typeof tenant>>;
const draft = (t: T, content: string, accounts = [t.account.id], extra: Record<string, unknown> = {}) =>
  savePost(t.ctx, { content, accountIds: accounts, ...extra });
const inMinutes = (n: number, tz = "America/New_York") => utcToLocalInput(new Date(Date.now() + n * MIN), tz);
const statusOf = async (postId: string) => (await systemDb.post.findUniqueOrThrow({ where: { id: postId }, include: { targets: true } }));

beforeAll(async () => {
  process.env.PUBLISH_RETRY_BASE_MS = "60000";
  await cleanupTestData();
  adminId = (await systemDb.user.create({ data: { email: testEmail("sched-admin"), platformRole: "SUPER_ADMIN" } })).id;
});
afterAll(async () => {
  await getQueue(QUEUES.publish).obliterate({ force: true });
  await getQueue(QUEUES.publish).close();
  await cleanupTestData();
  await db.$disconnect();
});

describe("acceptance: a scheduled post publishes via the mock at the right time", () => {
  it("not before its time; published after; correct statuses throughout", async () => {
    const t = await tenant("sch-basic");
    const post = await draft(t, "Hello from the scheduler", [t.account.id, t.linkedin.id]);
    const r = await schedulePost(t.ctx, post.id, { mode: "at", localDateTime: inMinutes(10), timezone: "America/New_York" });
    expect(r.ok).toBe(true);
    const sched = await systemDb.postSchedule.findUniqueOrThrow({ where: { postId: post.id } });

    // A delayed BullMQ job exists for exactly that time.
    const jobs = await getQueue(QUEUES.publish).getJobs(["delayed"]);
    const job = jobs.find((j) => j.data.postId === post.id)!;
    expect(job).toBeTruthy();
    expect(Math.abs(job.timestamp + job.opts.delay! - sched.scheduledAt.getTime())).toBeLessThan(2000);

    // Early (e.g. a duplicate job): nothing happens.
    expect((await processPublishJob(post.id, new Date(sched.scheduledAt.getTime() - MIN))).status).toBe("SKIPPED");
    expect((await statusOf(post.id)).status).toBe("SCHEDULED");

    // At the scheduled time: published to both platforms.
    const run = await processPublishJob(post.id, new Date(sched.scheduledAt.getTime() + 1000));
    expect(run).toMatchObject({ status: "PUBLISHED", published: 2, failed: 0 });
    const done = await statusOf(post.id);
    expect(done.status).toBe("PUBLISHED");
    expect(done.publishedAt).toBeTruthy();
    expect(done.targets.every((x) => x.status === "PUBLISHED" && x.externalUrl?.startsWith("https://mock.social/"))).toBe(true);
  });

  it("stores the UTC instant for the chosen wall-clock time and timezone", async () => {
    const t = await tenant("sch-tz");
    const post = await draft(t, "tz test");
    const local = "2027-01-15T09:00";
    await schedulePost(t.ctx, post.id, { mode: "at", localDateTime: local, timezone: "Asia/Tokyo" });
    const s = await systemDb.postSchedule.findUniqueOrThrow({ where: { postId: post.id } });
    expect(s.scheduledAt.toISOString()).toBe("2027-01-15T00:00:00.000Z");
    expect(s.timezone).toBe("Asia/Tokyo");
  });

  it("publish now", async () => {
    const t = await tenant("sch-now");
    const post = await draft(t, "right now");
    await schedulePost(t.ctx, post.id, { mode: "now" });
    expect((await processPublishJob(post.id)).status).toBe("PUBLISHED");
  });
});

describe("validation before scheduling", () => {
  it("refuses to schedule a post that breaks a target's rules, with per-account reasons", async () => {
    const t = await tenant("sch-invalid");
    const post = await draft(t, "x".repeat(300), [t.account.id, t.linkedin.id]); // too long for X only
    const r = await schedulePost(t.ctx, post.id, { mode: "now" });
    expect(r.ok).toBe(false);
    const x = r.checks.find((c) => c.platform === "X")!;
    expect(x.errors[0]!.code).toBe("text_too_long");
    expect(r.checks.find((c) => c.platform === "LINKEDIN")!.ok).toBe(true);
    expect((await statusOf(post.id)).status).toBe("DRAFT");
  });

  it("per-platform overrides fix it", async () => {
    const t = await tenant("sch-override");
    const post = await draft(t, "x".repeat(300), [t.account.id, t.linkedin.id], { platformOverrides: { X: { content: "Short for X" } } });
    expect((await schedulePost(t.ctx, post.id, { mode: "now" })).ok).toBe(true);
    await processPublishJob(post.id);
    expect((await statusOf(post.id)).status).toBe("PUBLISHED");
  });

  it("rejects no targets, past times and far-future times", async () => {
    const t = await tenant("sch-guards");
    const empty = await savePost(t.ctx, { content: "no targets", accountIds: [] });
    await expect(schedulePost(t.ctx, empty.id, { mode: "now" })).rejects.toThrow(/at least one account/);
    const post = await draft(t, "guards");
    await expect(schedulePost(t.ctx, post.id, { mode: "at", localDateTime: inMinutes(-30) })).rejects.toThrow(/past/);
    await expect(schedulePost(t.ctx, post.id, { mode: "at", localDateTime: inMinutes(60 * 24 * 400) })).rejects.toThrow(/one year/);
    await expect(schedulePost(t.ctx, post.id, { mode: "at", localDateTime: "garbage" })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("retries and failures", () => {
  it("transient errors retry with backoff, then give up after MAX_ATTEMPTS", async () => {
    const t = await tenant("sch-retry");
    const post = await draft(t, "flaky [mock:fail]");
    await schedulePost(t.ctx, post.id, { mode: "now" });
    let now = new Date();
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      const r = await processPublishJob(post.id, now);
      expect(r).toMatchObject({ status: "PUBLISHING", pending: 1 });
      const target = (await statusOf(post.id)).targets[0]!;
      expect(target).toMatchObject({ status: "PENDING", attempts: attempt });
      expect(target.nextAttemptAt!.getTime() - now.getTime()).toBe(backoffMs(attempt));
      expect(target.lastError).toMatch(/temporarily unavailable/);
      // Not yet due: a job firing early does nothing.
      await processPublishJob(post.id, new Date(now.getTime() + 1000));
      expect((await statusOf(post.id)).targets[0]!.attempts).toBe(attempt);
      now = new Date(target.nextAttemptAt!.getTime() + 1);
    }
    const final = await processPublishJob(post.id, now);
    expect(final.status).toBe("FAILED");
    const t2 = (await statusOf(post.id)).targets[0]!;
    expect(t2).toMatchObject({ status: "FAILED", attempts: MAX_ATTEMPTS });
  });

  it("permanent errors fail immediately; mixed outcomes are PARTIALLY_PUBLISHED; retry only re-sends failures", async () => {
    const t = await tenant("sch-partial");
    const post = await draft(t, "fine everywhere", [t.account.id, t.linkedin.id], { platformOverrides: { X: { content: "nope [mock:reject]" } } });
    await schedulePost(t.ctx, post.id, { mode: "now" });
    expect((await processPublishJob(post.id)).status).toBe("PARTIALLY_PUBLISHED");
    const after = await statusOf(post.id);
    const li = after.targets.find((x) => x.socialAccountId === t.linkedin.id)!;
    expect(li.status).toBe("PUBLISHED");

    const spy = vi.spyOn(MockPublisher.prototype, "publish");
    await retryFailedTargets(t.ctx, post.id);
    expect((await statusOf(post.id)).status).toBe("SCHEDULED");
    await processPublishJob(post.id);
    expect(spy).toHaveBeenCalledTimes(1); // only X was re-sent
    spy.mockRestore();
    const again = await statusOf(post.id);
    expect(again.targets.find((x) => x.socialAccountId === t.linkedin.id)!.externalPostId).toBe(li.externalPostId);
  });

  it("an expired token fails the target with a reconnect message and marks the account EXPIRED", async () => {
    const t = await tenant("sch-expired");
    await tenantDb(t.workspace.id).socialAccount.update({ where: { id: t.account.id }, data: { accessTokenEnc: encryptSecret("expired-token") } });
    const post = await draft(t, "will hit 401");
    await schedulePost(t.ctx, post.id, { mode: "now" });
    expect((await processPublishJob(post.id)).status).toBe("FAILED");
    expect((await statusOf(post.id)).targets[0]!.lastError).toMatch(/Reconnect the account/);
    expect((await systemDb.socialAccount.findUniqueOrThrow({ where: { id: t.account.id } })).status).toBe("EXPIRED");
  });

  it("concurrent jobs for the same post never publish a target twice", async () => {
    const t = await tenant("sch-race");
    const post = await draft(t, "only once", [t.account.id, t.linkedin.id]);
    await schedulePost(t.ctx, post.id, { mode: "now" });
    const spy = vi.spyOn(MockPublisher.prototype, "publish");
    await Promise.all(Array.from({ length: 5 }, () => processPublishJob(post.id)));
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
    expect((await statusOf(post.id)).status).toBe("PUBLISHED");
  });
});

describe("lifecycle", () => {
  it("unschedule returns to draft and the pending job becomes a no-op; can't unschedule mid-publish", async () => {
    const t = await tenant("sch-unsched");
    const post = await draft(t, "maybe later");
    await schedulePost(t.ctx, post.id, { mode: "at", localDateTime: inMinutes(30) });
    await unschedulePost(t.ctx, post.id);
    expect((await statusOf(post.id)).status).toBe("DRAFT");
    expect((await processPublishJob(post.id, new Date(Date.now() + 60 * MIN))).status).toBe("SKIPPED");

    await schedulePost(t.ctx, post.id, { mode: "now" });
    await systemDb.post.update({ where: { id: post.id }, data: { status: "PUBLISHING" } });
    await expect(unschedulePost(t.ctx, post.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("published posts can't be edited", async () => {
    const t = await tenant("sch-locked");
    const post = await draft(t, "done");
    await schedulePost(t.ctx, post.id, { mode: "now" });
    await processPublishJob(post.id);
    await expect(savePost(t.ctx, { postId: post.id, content: "changed", accountIds: [t.account.id] })).rejects.toThrow(/can't be edited/);
  });

  it("other workspaces can't schedule or see the post", async () => {
    const A = await tenant("sch-iso-a");
    const B = await tenant("sch-iso-b");
    const post = await draft(A, "A's post");
    await expect(schedulePost(B.ctx, post.id, { mode: "now" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(savePost(B.ctx, { content: "steal", accountIds: [A.account.id] })).rejects.toThrow(/no longer exist/);
  });
});

describe("recurring posts and the queue", () => {
  it("weekly: after publishing, the next occurrence is scheduled at the same local time (once)", async () => {
    const t = await tenant("sch-weekly", { recurring: true });
    const post = await draft(t, "Weekly roast drop");
    await schedulePost(t.ctx, post.id, { mode: "at", localDateTime: inMinutes(5), recurrence: { freq: "WEEKLY" } });
    const first = await systemDb.postSchedule.findUniqueOrThrow({ where: { postId: post.id } });
    await processPublishJob(post.id, new Date(first.scheduledAt.getTime() + 1000));

    const series = await systemDb.post.findMany({ where: { seriesId: post.id }, include: { schedule: true, targets: true }, orderBy: { createdAt: "asc" } });
    expect(series.map((p) => p.status)).toEqual(["PUBLISHED", "SCHEDULED"]);
    const next = series[1]!;
    expect(next.schedule!.recurrenceRule).toBe("FREQ=WEEKLY");
    expect(utcToLocalInput(next.schedule!.scheduledAt, "America/New_York").slice(11)).toBe(utcToLocalInput(first.scheduledAt, "America/New_York").slice(11));
    expect(next.schedule!.scheduledAt.getTime() - first.scheduledAt.getTime()).toBeGreaterThanOrEqual(7 * 24 * 60 * MIN - 60 * MIN);
    expect(next.targets).toHaveLength(1);

    // Re-running the finished post doesn't create a duplicate occurrence.
    await processPublishJob(post.id);
    expect(await systemDb.post.count({ where: { seriesId: post.id } })).toBe(2);
  });

  it("recurrence requires the plan feature", async () => {
    const t = await tenant("sch-norecur"); // free plan
    const post = await draft(t, "repeat me");
    await expect(schedulePost(t.ctx, post.id, { mode: "now", recurrence: { freq: "DAILY" } })).rejects.toBeInstanceOf(LimitExceededError);
  });

  it("add to queue picks the next free slot, then the one after", async () => {
    const t = await tenant("sch-queue");
    await updateQueueSlots(t.ctx, [{ day: 1, time: "09:00" }, { day: 3, time: "09:00" }, { day: 5, time: "09:00" }]);
    const a = await draft(t, "queued one");
    const b = await draft(t, "queued two");
    await schedulePost(t.ctx, a.id, { mode: "queue" });
    await schedulePost(t.ctx, b.id, { mode: "queue" });
    const [sa, sb] = await Promise.all([a, b].map((p) => systemDb.postSchedule.findUniqueOrThrow({ where: { postId: p.id } })));
    const la = utcToLocalInput(sa!.scheduledAt, "America/New_York");
    const lb = utcToLocalInput(sb!.scheduledAt, "America/New_York");
    expect(la.endsWith("T09:00") && lb.endsWith("T09:00")).toBe(true);
    expect(sb!.scheduledAt > sa!.scheduledAt).toBe(true);
    for (const local of [la, lb]) expect([1, 3, 5]).toContain(((new Date(`${local}:00Z`).getUTCDay() + 6) % 7) + 1);
  });

  it("queue with no slots explains what to do", async () => {
    const t = await tenant("sch-noslots");
    const post = await draft(t, "nowhere to go");
    await expect(schedulePost(t.ctx, post.id, { mode: "queue" })).rejects.toThrow(/no free slots/);
  });
});

describe("sweep (safety net)", () => {
  it("re-enqueues due posts whose job was lost, and fails targets stuck mid-publish", async () => {
    const t = await tenant("sch-sweep");
    const post = await draft(t, "lost job");
    await schedulePost(t.ctx, post.id, { mode: "now" });
    await getQueue(QUEUES.publish).obliterate({ force: true }); // simulate Redis losing the job
    const r = await sweepDuePosts();
    expect(r.due).toBeGreaterThanOrEqual(1);
    expect((await getQueue(QUEUES.publish).getJobs(["waiting", "delayed"])).some((j) => j.data.postId === post.id)).toBe(true);

    const stuckPost = await draft(t, "crashed worker");
    await schedulePost(t.ctx, stuckPost.id, { mode: "now" });
    await systemDb.post.update({ where: { id: stuckPost.id }, data: { status: "PUBLISHING" } });
    await systemDb.postTarget.updateMany({ where: { postId: stuckPost.id }, data: { status: "PUBLISHING", lastAttemptAt: new Date(Date.now() - 20 * MIN) } });
    await sweepDuePosts();
    const s = await statusOf(stuckPost.id);
    expect(s.targets[0]).toMatchObject({ status: "FAILED" });
    expect(s.targets[0]!.lastError).toMatch(/avoid a duplicate/);
    expect((await processPublishJob(stuckPost.id)).status).toBe("FAILED");
  });

  it("schedules use the post's own timezone for DST-safe local times", () => {
    expect(localToUtc("2027-03-15T09:00", "America/New_York")!.toISOString()).toBe("2027-03-15T13:00:00.000Z");
  });
});
