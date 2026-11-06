import { describe, expect, it } from "vitest";
import type { Plan, Subscription } from "@prisma/client";
import { applyOverrides, currentPeriod, monthlyRevenueCents, planLimits, resolveEntitlements, type SubscriptionWithPlans } from "@/server/billing/limits";

const now = new Date("2026-06-15T12:00:00Z");

const plan = (key: string, over: Partial<Plan> = {}): Plan => ({
  id: `plan_${key}`, key, name: key[0]!.toUpperCase() + key.slice(1), description: null, priceCents: key === "free" ? 0 : 4900,
  currency: "usd", interval: "MONTH", stripePriceId: null, stripeProductId: null,
  maxPostsPerMonth: key === "free" ? 10 : 500, monthlyCredits: key === "free" ? 20 : 1000, maxSocialAccounts: key === "free" ? 2 : 15,
  maxMembers: key === "free" ? 1 : 5, features: key === "free" ? {} : { video: true, byok: true, recurring: true },
  isActive: true, isPublic: true, sortOrder: 0, createdAt: now, updatedAt: now, ...over,
});
const FREE = plan("free");
const PRO = plan("pro");

const sub = (over: Partial<Subscription> & { plan?: Plan; compPlan?: Plan | null } = {}): SubscriptionWithPlans => ({
  id: "sub", workspaceId: "ws", planId: (over.plan ?? FREE).id, status: "ACTIVE", isComped: false, compPlanId: null,
  compOverrides: null, compReason: null, compedById: null, compedAt: null, compExpiresAt: null, stripeCustomerId: null,
  stripeSubscriptionId: null, stripePriceId: null, priceCents: null, billingInterval: null, currentPeriodStart: null,
  currentPeriodEnd: null, cancelAtPeriodEnd: false, lastEventAt: null, createdAt: now, updatedAt: now,
  plan: FREE, compPlan: null, ...over,
});

describe("resolveEntitlements", () => {
  it("no subscription → free plan", () => {
    const e = resolveEntitlements(null, FREE, now);
    expect(e.source).toBe("free");
    expect(e.limits.maxSocialAccounts).toBe(2);
    expect(e.features.video).toBe(false);
  });

  it("active paid subscription → billed plan", () => {
    const e = resolveEntitlements(sub({ plan: PRO, stripeSubscriptionId: "sub_1" }), FREE, now);
    expect(e).toMatchObject({ source: "paid", plan: { key: "pro" } });
    expect(e.features.video).toBe(true);
  });

  it("PAST_DUE keeps access (grace while the provider retries)", () => {
    expect(resolveEntitlements(sub({ plan: PRO, stripeSubscriptionId: "s", status: "PAST_DUE" }), FREE, now).source).toBe("paid");
  });

  it.each(["CANCELED", "UNPAID", "INCOMPLETE"] as const)("%s paid subscription → lapsed to free", (status) => {
    const e = resolveEntitlements(sub({ plan: PRO, stripeSubscriptionId: "s", status }), FREE, now);
    expect(e.source).toBe("lapsed");
    expect(e.plan.key).toBe("free");
  });

  it("a paid plan with no provider subscription grants nothing (can't self-assign a plan)", () => {
    expect(resolveEntitlements(sub({ plan: PRO }), FREE, now).plan.key).toBe("free");
  });

  it("full comp → comp plan, even when billed plan is free", () => {
    const e = resolveEntitlements(sub({ isComped: true, compPlan: PRO, compPlanId: PRO.id }), FREE, now);
    expect(e).toMatchObject({ source: "comp", plan: { key: "pro" } });
    expect(e.limits.maxSocialAccounts).toBe(15);
  });

  it("comp takes precedence over a paid subscription", () => {
    const AGENCY = plan("agency", { maxSocialAccounts: 50 });
    const e = resolveEntitlements(sub({ plan: PRO, stripeSubscriptionId: "s", isComped: true, compPlan: AGENCY }), FREE, now);
    expect(e.limits.maxSocialAccounts).toBe(50);
  });

  it("partial comp → comp plan + overrides", () => {
    const e = resolveEntitlements(
      sub({ isComped: true, compPlan: FREE, compOverrides: { limits: { maxSocialAccounts: 10, monthlyCredits: -1 }, features: { video: true } } }),
      FREE,
      now,
    );
    expect(e.limits).toMatchObject({ maxSocialAccounts: 10, monthlyCredits: -1, maxPostsPerMonth: 10 });
    expect(e.features).toEqual({ video: true, byok: false, recurring: false });
  });

  it("expired comp → falls back (to free when nothing is billed)", () => {
    const e = resolveEntitlements(sub({ isComped: true, compPlan: PRO, compExpiresAt: new Date("2026-06-01Z") }), FREE, now);
    expect(e.plan.key).toBe("free");
  });

  it("expired comp on a paying workspace → their paid plan", () => {
    const e = resolveEntitlements(sub({ plan: PRO, stripeSubscriptionId: "s", isComped: true, compPlan: plan("agency"), compExpiresAt: new Date("2026-06-01Z") }), FREE, now);
    expect(e).toMatchObject({ source: "paid", plan: { key: "pro" } });
  });

  it("ignores malformed overrides instead of granting anything", () => {
    const e = resolveEntitlements(sub({ isComped: true, compPlan: FREE, compOverrides: { limits: { maxSocialAccounts: "lots" } } }), FREE, now);
    expect(e.limits.maxSocialAccounts).toBe(2);
  });
});

describe("applyOverrides / planLimits", () => {
  it("unspecified keys keep the plan values", () => {
    const r = applyOverrides(planLimits(PRO), { limits: { maxMembers: 99 } });
    expect(r.limits).toEqual({ maxPostsPerMonth: 500, monthlyCredits: 1000, maxSocialAccounts: 15, maxMembers: 99 });
  });
});

describe("currentPeriod", () => {
  it("uses the subscription period when now is inside it", () => {
    const p = currentPeriod({ currentPeriodStart: new Date("2026-06-10Z"), currentPeriodEnd: new Date("2026-07-10Z") }, now);
    expect(p.start.toISOString()).toBe("2026-06-10T00:00:00.000Z");
  });
  it("falls back to the UTC calendar month", () => {
    const p = currentPeriod(null, now);
    expect([p.start.toISOString(), p.end.toISOString()]).toEqual(["2026-06-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z"]);
    const stale = currentPeriod({ currentPeriodStart: new Date("2026-01-01Z"), currentPeriodEnd: new Date("2026-02-01Z") }, now);
    expect(stale.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("monthlyRevenueCents", () => {
  const base = { status: "ACTIVE" as const, stripeSubscriptionId: "s", isComped: false, compExpiresAt: null };
  it("monthly and yearly (normalized) prices", () => {
    expect(monthlyRevenueCents({ ...base, priceCents: 4900, billingInterval: "MONTH" }, now)).toBe(4900);
    expect(monthlyRevenueCents({ ...base, priceCents: 49000, billingInterval: "YEAR" }, now)).toBe(4083);
  });
  it("comped, canceled and free contribute nothing", () => {
    expect(monthlyRevenueCents({ ...base, priceCents: 4900, billingInterval: "MONTH", isComped: true }, now)).toBe(0);
    expect(monthlyRevenueCents({ ...base, priceCents: 4900, billingInterval: "MONTH", status: "CANCELED" }, now)).toBe(0);
    expect(monthlyRevenueCents({ ...base, priceCents: null, billingInterval: null }, now)).toBe(0);
  });
});
