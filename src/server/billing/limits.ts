import { z } from "zod";
import type { Plan, Subscription, SubscriptionStatus } from "@prisma/client";

/**
 * Pure entitlement logic (no I/O) so it can be unit-tested exhaustively.
 * Convention: a numeric limit of -1 means unlimited.
 */

export const LIMIT_KEYS = ["maxPostsPerMonth", "monthlyCredits", "maxSocialAccounts", "maxMembers"] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export type Limits = Record<LimitKey, number>;

export const FEATURE_KEYS = ["video", "byok", "recurring"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type Features = Record<FeatureKey, boolean>;

export const LIMIT_LABELS: Record<LimitKey, string> = {
  maxPostsPerMonth: "posts per period",
  monthlyCredits: "AI credits per period",
  maxSocialAccounts: "connected accounts",
  maxMembers: "members",
};

const SINGULAR: Record<LimitKey, string> = {
  maxPostsPerMonth: "post per period",
  monthlyCredits: "AI credit per period",
  maxSocialAccounts: "connected account",
  maxMembers: "member",
};

export function limitPhrase(key: LimitKey, n: number) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? SINGULAR[key] : LIMIT_LABELS[key]}`;
}

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  video: "AI video generation",
  byok: "Bring your own AI keys",
  recurring: "Recurring posts",
};

export const UNLIMITED = -1;
export const isUnlimited = (n: number) => n < 0;

const limitValue = z.number().int().min(-1).max(10_000_000);

export const compOverridesSchema = z
  .object({
    limits: z.object(Object.fromEntries(LIMIT_KEYS.map((k) => [k, limitValue.optional()])) as Record<LimitKey, z.ZodOptional<typeof limitValue>>).partial().optional(),
    features: z.object(Object.fromEntries(FEATURE_KEYS.map((k) => [k, z.boolean().optional()])) as Record<FeatureKey, z.ZodOptional<z.ZodBoolean>>).partial().optional(),
  })
  .strict();

export type CompOverrides = z.infer<typeof compOverridesSchema>;

export function parseFeatures(json: unknown): Features {
  const obj = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, obj[k] === true])) as Features;
}

type PlanLimitsSource = Pick<Plan, LimitKey | "features">;

export function planLimits(plan: PlanLimitsSource): { limits: Limits; features: Features } {
  return {
    limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, plan[k]])) as Limits,
    features: parseFeatures(plan.features),
  };
}

export function applyOverrides(base: { limits: Limits; features: Features }, raw: unknown) {
  const parsed = compOverridesSchema.safeParse(raw ?? {});
  const o = parsed.success ? parsed.data : {};
  return {
    limits: { ...base.limits, ...stripUndefined(o.limits ?? {}) } as Limits,
    features: { ...base.features, ...stripUndefined(o.features ?? {}) } as Features,
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Statuses during which a PAID subscription grants its plan. PAST_DUE = grace while Stripe retries. */
export const ACCESS_STATUSES: SubscriptionStatus[] = ["ACTIVE", "TRIALING", "PAST_DUE"];

export type EntitlementSource = "comp" | "paid" | "free" | "lapsed";

export type SubscriptionWithPlans = Subscription & { plan: Plan; compPlan: Plan | null };

export function isCompActive(sub: Pick<Subscription, "isComped" | "compExpiresAt">, now: Date) {
  return sub.isComped && (!sub.compExpiresAt || sub.compExpiresAt > now);
}

export function hasPaidAccess(sub: Pick<Subscription, "status" | "stripeSubscriptionId">) {
  return !!sub.stripeSubscriptionId && ACCESS_STATUSES.includes(sub.status);
}

/**
 * Which plan's entitlements apply right now.
 *  1. Active comp → comp plan (+ partial overrides)
 *  2. Paid subscription in good standing → billed plan
 *  3. Billed plan is free → that plan
 *  4. Otherwise (canceled/unpaid/expired comp) → the free plan
 */
export function resolveEntitlements(sub: SubscriptionWithPlans | null, freePlan: Plan, now = new Date()) {
  let plan: Plan = freePlan;
  let source: EntitlementSource = "free";
  let overrides: unknown;

  if (sub && isCompActive(sub, now)) {
    plan = sub.compPlan ?? sub.plan;
    source = "comp";
    overrides = sub.compOverrides;
  } else if (sub && hasPaidAccess(sub)) {
    plan = sub.plan;
    source = "paid";
  } else if (sub && sub.plan.priceCents === 0) {
    plan = sub.plan;
    source = "free";
  } else if (sub) {
    source = "lapsed";
  }

  const { limits, features } = applyOverrides(planLimits(plan), overrides);
  return { plan, source, limits, features, period: currentPeriod(sub, now) };
}

/**
 * Usage window. Uses the subscription's billing period when `now` falls inside it
 * (paid plans); otherwise the current calendar month in UTC (free/comped).
 */
export function currentPeriod(
  sub: Pick<Subscription, "currentPeriodStart" | "currentPeriodEnd"> | null,
  now = new Date(),
): { start: Date; end: Date } {
  if (sub?.currentPeriodStart && sub.currentPeriodEnd && sub.currentPeriodStart <= now && now < sub.currentPeriodEnd) {
    return { start: sub.currentPeriodStart, end: sub.currentPeriodEnd };
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/** Monthly-recurring-revenue contribution of one subscription, in cents. */
export function monthlyRevenueCents(sub: Pick<Subscription, "priceCents" | "billingInterval" | "status" | "stripeSubscriptionId" | "isComped" | "compExpiresAt">, now = new Date()) {
  if (!hasPaidAccess(sub) || isCompActive(sub, now) || !sub.priceCents) return 0;
  return sub.billingInterval === "YEAR" ? Math.round(sub.priceCents / 12) : sub.priceCents;
}
