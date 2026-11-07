import type { Prisma } from "@prisma/client";
import { withTenantTx, type Tx } from "@/lib/db";
import { LimitExceededError } from "@/server/errors";
import {
  FEATURE_LABELS,
  limitPhrase,
  isUnlimited,
  resolveEntitlements,
  type FeatureKey,
  type LimitKey,
} from "./limits";

/**
 * Entitlements + usage for a workspace. Every function takes a transaction
 * (tenant-scoped or system) so checks and the writes they guard are atomic.
 */

export const FREE_PLAN_KEY = "free";

export async function getFreePlan(tx: Tx) {
  const free = await tx.plan.findUnique({ where: { key: FREE_PLAN_KEY } });
  if (!free) throw new Error(`The "${FREE_PLAN_KEY}" plan is missing; run the seed`);
  return free;
}

export async function getEntitlements(tx: Tx, workspaceId: string, now = new Date()) {
  const [sub, freePlan] = await Promise.all([
    tx.subscription.findUnique({ where: { workspaceId }, include: { plan: true, compPlan: true } }),
    getFreePlan(tx),
  ]);
  return { ...resolveEntitlements(sub, freePlan, now), subscription: sub };
}

export type Entitlements = Awaited<ReturnType<typeof getEntitlements>>;

/** Credits consumed (negative) or granted (positive) in the period; balance = allowance + this. */
async function ledgerSum(tx: Tx, workspaceId: string, period: { start: Date; end: Date }) {
  const agg = await tx.creditLedgerEntry.aggregate({
    where: { workspaceId, createdAt: { gte: period.start, lt: period.end } },
    _sum: { delta: true },
  });
  return agg._sum.delta ?? 0;
}

export async function getUsage(tx: Tx, workspaceId: string, ent: Pick<Entitlements, "period">) {
  const [posts, socialAccounts, members, pendingInvites, ledger] = await Promise.all([
    tx.post.count({ where: { workspaceId, createdAt: { gte: ent.period.start, lt: ent.period.end } } }),
    tx.socialAccount.count({ where: { workspaceId, status: { not: "DISCONNECTED" } } }),
    tx.membership.count({ where: { workspaceId } }),
    tx.invitation.count({ where: { workspaceId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }),
    ledgerSum(tx, workspaceId, ent.period),
  ]);
  return {
    maxPostsPerMonth: posts,
    maxSocialAccounts: socialAccounts,
    maxMembers: members + pendingInvites, // pending invites reserve seats
    members,
    pendingInvites,
    creditsUsed: Math.max(0, -ledger),
    creditLedgerSum: ledger,
  };
}

export type Usage = Awaited<ReturnType<typeof getUsage>>;

export function creditsRemaining(ent: Pick<Entitlements, "limits">, usage: Pick<Usage, "creditLedgerSum">) {
  if (isUnlimited(ent.limits.monthlyCredits)) return Number.POSITIVE_INFINITY;
  return Math.max(0, ent.limits.monthlyCredits + usage.creditLedgerSum);
}

function limitMessage(ent: Entitlements, key: LimitKey) {
  const what = ent.source === "comp" ? "Your workspace's plan" : `The ${ent.plan.name} plan`;
  return `${what} allows ${limitPhrase(key, ent.limits[key])}. Upgrade your plan to add more.`;
}

/** Throws LimitExceededError if adding `adding` units of `key` would exceed the plan. */
export async function assertWithinLimit(
  tx: Tx,
  workspaceId: string,
  key: Exclude<LimitKey, "monthlyCredits">,
  opts: { adding?: number; countPendingInvites?: boolean } = {},
) {
  const adding = opts.adding ?? 1;
  const ent = await getEntitlements(tx, workspaceId);
  const max = ent.limits[key];
  if (isUnlimited(max)) return ent;
  const usage = await getUsage(tx, workspaceId, ent);
  const current = key === "maxMembers" && opts.countPendingInvites === false ? usage.members : usage[key];
  if (current + adding > max) throw new LimitExceededError(limitMessage(ent, key), key);
  return ent;
}

export async function assertFeature(tx: Tx, workspaceId: string, feature: FeatureKey) {
  const ent = await getEntitlements(tx, workspaceId);
  if (!ent.features[feature]) {
    throw new LimitExceededError(`${FEATURE_LABELS[feature]} isn't included in your plan. Upgrade to use it.`, feature);
  }
  return ent;
}

/** Serialize credit spending per workspace (transaction-scoped advisory lock). */
async function lockWorkspaceCredits(tx: Tx, workspaceId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`credits:${workspaceId}`}, 0))`;
}

/**
 * Atomically spend platform credits. Concurrent calls for the same workspace are
 * serialized, so the balance can never go below zero.
 */
export async function consumeCredits(
  workspaceId: string,
  amount: number,
  meta: { reason?: string; generationRequestId?: string; note?: string } = {},
) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("consumeCredits: amount must be a positive integer");
  return withTenantTx(workspaceId, async (tx) => {
    await lockWorkspaceCredits(tx, workspaceId);
    const ent = await getEntitlements(tx, workspaceId);
    const usage = await getUsage(tx, workspaceId, ent);
    const remaining = creditsRemaining(ent, usage);
    if (remaining < amount) {
      throw new LimitExceededError(
        `Not enough AI credits: ${remaining} left this period, ${amount} needed. Upgrade or add your own API key.`,
        "monthlyCredits",
      );
    }
    const entry = await tx.creditLedgerEntry.create({
      data: { workspaceId, delta: -amount, reason: meta.reason ?? "generation", generationRequestId: meta.generationRequestId, note: meta.note },
    });
    return { entry, remaining: remaining - amount };
  });
}

/** Give credits back (e.g. a generation failed after charging). */
export async function refundCredits(workspaceId: string, amount: number, note?: string, tx?: Prisma.TransactionClient) {
  const run = (t: Tx) => t.creditLedgerEntry.create({ data: { workspaceId, delta: amount, reason: "refund", note } });
  return tx ? run(tx) : withTenantTx(workspaceId, run);
}

/** Net credits currently charged for one generation (positive = charged). */
async function netChargedFor(tx: Tx, workspaceId: string, generationRequestId: string) {
  const agg = await tx.creditLedgerEntry.aggregate({ where: { workspaceId, generationRequestId }, _sum: { delta: true } });
  return -(agg._sum.delta ?? 0);
}

/**
 * Idempotently make the net charge for a generation equal `cost`.
 * Safe to call again on job retries: it never charges twice.
 */
export async function chargeGeneration(workspaceId: string, generationRequestId: string, cost: number) {
  return withTenantTx(workspaceId, async (tx) => {
    await lockWorkspaceCredits(tx, workspaceId);
    const already = await netChargedFor(tx, workspaceId, generationRequestId);
    const due = cost - already;
    if (due <= 0) return { charged: already };
    const ent = await getEntitlements(tx, workspaceId);
    const remaining = creditsRemaining(ent, await getUsage(tx, workspaceId, ent));
    if (remaining < due) {
      throw new LimitExceededError(
        `Not enough AI credits: ${remaining} left this period, ${due} needed. Upgrade or add your own API key.`,
        "monthlyCredits",
      );
    }
    await tx.creditLedgerEntry.create({ data: { workspaceId, delta: -due, reason: "generation", generationRequestId } });
    return { charged: cost };
  });
}

/** Idempotently return whatever is still charged for a generation. */
export async function refundGeneration(workspaceId: string, generationRequestId: string, note?: string) {
  return withTenantTx(workspaceId, async (tx) => {
    await lockWorkspaceCredits(tx, workspaceId);
    const net = await netChargedFor(tx, workspaceId, generationRequestId);
    if (net <= 0) return 0;
    await tx.creditLedgerEntry.create({ data: { workspaceId, delta: net, reason: "refund", generationRequestId, note } });
    return net;
  });
}
