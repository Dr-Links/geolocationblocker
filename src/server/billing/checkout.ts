import { randomBytes } from "node:crypto";
import { systemDb } from "@/lib/db";
import { verifyToken } from "@/lib/signed-token";
import { ConflictError, ForbiddenError, NotFoundError } from "@/server/errors";
import { auditActor, recordAudit } from "@/server/services/audit";
import { assertCan } from "@/server/tenancy/guard";
import type { TenantContext } from "@/server/tenancy/types";
import { hasPaidAccess, isCompActive, monthlyRevenueCents } from "./limits";
import { getBillingProvider } from "./providers";
import {
  MOCK_CARDS,
  MOCK_CHECKOUT_PURPOSE,
  MOCK_PORTAL_PURPOSE,
  addInterval,
  mockEventId,
  type MockCheckoutToken,
  type MockPortalToken,
} from "./providers/mock";
import { applyBillingEvent } from "./sync";

const appUrl = () => process.env.APP_URL ?? "http://localhost:3000";

/** Plans a workspace can buy: active, public, paid, with a current price. */
export async function listPurchasablePlans() {
  return systemDb.plan.findMany({
    where: { isActive: true, isPublic: true },
    orderBy: [{ sortOrder: "asc" }, { priceCents: "asc" }],
  });
}

/**
 * Start a subscription for a plan. Returns the URL to send the browser to:
 * a Stripe Checkout page, the mock checkout, or (for an existing paid
 * subscription) the billing portal, where plan changes are prorated.
 */
export async function startCheckout(ctx: TenantContext & { user: { email: string } }, planId: string) {
  assertCan(ctx, "billing.manage");
  const plan = await systemDb.plan.findUnique({ where: { id: planId } });
  if (!plan || !plan.isActive || !plan.isPublic) throw new NotFoundError("That plan isn't available");
  if (plan.priceCents === 0 || !plan.stripePriceId) throw new ConflictError("That plan doesn't require checkout");

  const sub = await ctx.db.subscription.findUnique({ where: { workspaceId: ctx.workspaceId } });
  if (sub && isCompActive(sub, new Date())) {
    throw new ConflictError("This workspace is complimentary (comped by the platform). No payment is needed.");
  }

  const provider = getBillingProvider();
  if (sub && hasPaidAccess(sub) && sub.stripeCustomerId) {
    return provider.createPortalSession({
      customerId: sub.stripeCustomerId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      returnUrl: `${appUrl()}/dashboard/billing`,
    });
  }

  const session = await provider.createCheckoutSession({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    customerId: sub?.stripeCustomerId,
    customerEmail: ctx.user.email,
    priceId: plan.stripePriceId,
    planName: plan.name,
    successUrl: `${appUrl()}/dashboard/billing?checkout=success`,
    cancelUrl: `${appUrl()}/dashboard/billing?checkout=cancel`,
  });
  await recordAudit({ action: "billing.checkout.start", ...auditActor(ctx), targetType: "Plan", targetId: plan.id, metadata: { provider: provider.name } });
  return session;
}

export async function openBillingPortal(ctx: TenantContext) {
  assertCan(ctx, "billing.manage");
  const sub = await ctx.db.subscription.findUnique({ where: { workspaceId: ctx.workspaceId } });
  if (!sub?.stripeCustomerId) throw new ConflictError("There's no billing account yet. Choose a paid plan first.");
  return getBillingProvider().createPortalSession({
    customerId: sub.stripeCustomerId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    returnUrl: `${appUrl()}/dashboard/billing`,
  });
}

// ─── Mock provider flows (used only when Stripe isn't configured) ──────────

async function assertMockAccess(token: { w: string; u: string }, userId: string) {
  if (getBillingProvider().name !== "mock") throw new ForbiddenError("Mock billing is disabled");
  if (token.u !== userId) throw new ForbiddenError("This checkout link belongs to another user");
  const m = await systemDb.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId: token.w } } });
  if (m?.role !== "WORKSPACE_ADMIN") throw new ForbiddenError();
}

export async function loadMockCheckout(rawToken: string, userId: string) {
  const t = verifyToken<MockCheckoutToken>(rawToken, MOCK_CHECKOUT_PURPOSE);
  if (!t) throw new NotFoundError("This checkout session has expired. Start again from Billing.");
  await assertMockAccess(t, userId);
  const price = await systemDb.planPrice.findUnique({ where: { providerPriceId: t.p }, include: { plan: true } });
  const ws = await systemDb.workspace.findUnique({ where: { id: t.w }, select: { name: true } });
  if (!price || !ws) throw new NotFoundError("Unknown plan");
  return { token: t, price, workspaceName: ws.name };
}

/** "Pay" on the mock checkout. Emits the same events a Stripe webhook would. */
export async function completeMockCheckout(rawToken: string, userId: string, cardNumber: string) {
  const { token, price } = await loadMockCheckout(rawToken, userId);
  const card = cardNumber.replace(/\D/g, "");
  if (card === MOCK_CARDS.declined) throw new ConflictError("Your card was declined. (Mock: use 4242 4242 4242 4242.)");
  if (card !== MOCK_CARDS.success) throw new ConflictError("Use the test card 4242 4242 4242 4242.");

  const sub = await systemDb.subscription.findUnique({ where: { workspaceId: token.w } });
  const now = new Date();
  await applyBillingEvent({
    id: mockEventId(),
    type: "subscription.sync",
    occurredAt: now,
    workspaceId: token.w,
    customerId: sub?.stripeCustomerId ?? `mock_cus_${randomBytes(6).toString("hex")}`,
    subscriptionId: sub?.stripeSubscriptionId && hasPaidAccess(sub) ? sub.stripeSubscriptionId : `mock_sub_${randomBytes(6).toString("hex")}`,
    priceId: price.providerPriceId,
    unitAmountCents: price.priceCents,
    interval: price.interval,
    status: "ACTIVE",
    currentPeriodStart: now,
    currentPeriodEnd: addInterval(now, price.interval),
    cancelAtPeriodEnd: false,
  });
  return { workspaceId: token.w };
}

export async function loadMockPortal(rawToken: string, userId: string) {
  const t = verifyToken<MockPortalToken>(rawToken, MOCK_PORTAL_PURPOSE);
  if (!t) throw new NotFoundError("This portal session has expired. Open it again from Billing.");
  await assertMockAccess(t, userId);
  const sub = await systemDb.subscription.findUnique({ where: { workspaceId: t.w }, include: { plan: true } });
  if (!sub?.stripeCustomerId || !sub.stripeSubscriptionId) throw new NotFoundError("No subscription");
  const plans = await systemDb.plan.findMany({
    where: { isActive: true, isPublic: true, priceCents: { gt: 0 }, stripePriceId: { not: null } },
    orderBy: { sortOrder: "asc" },
  });
  return { token: t, sub, plans };
}

export type MockPortalAction =
  | { kind: "switch"; planId: string }
  | { kind: "cancel_at_period_end" }
  | { kind: "resume" }
  | { kind: "cancel_now" }
  | { kind: "simulate_renewal" }
  | { kind: "simulate_payment_failed" };

/** Mock customer portal: plan switch, cancel/resume, and lifecycle simulations for testing. */
export async function runMockPortalAction(rawToken: string, userId: string, action: MockPortalAction) {
  const { token, sub, plans } = await loadMockPortal(rawToken, userId);
  const base = {
    id: mockEventId(),
    occurredAt: new Date(),
    workspaceId: token.w,
    customerId: sub.stripeCustomerId!,
    subscriptionId: sub.stripeSubscriptionId!,
  };
  const current = {
    ...base,
    type: "subscription.sync" as const,
    priceId: sub.stripePriceId!,
    unitAmountCents: sub.priceCents,
    interval: sub.billingInterval,
    status: sub.status,
    currentPeriodStart: sub.currentPeriodStart ?? new Date(),
    currentPeriodEnd: sub.currentPeriodEnd ?? new Date(),
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };

  switch (action.kind) {
    case "switch": {
      const plan = plans.find((p) => p.id === action.planId);
      const price = plan && (await systemDb.planPrice.findUnique({ where: { providerPriceId: plan.stripePriceId! } }));
      if (!plan || !price) throw new NotFoundError("Plan not available");
      return applyBillingEvent({ ...current, priceId: price.providerPriceId, unitAmountCents: price.priceCents, interval: price.interval, cancelAtPeriodEnd: false });
    }
    case "cancel_at_period_end":
      return applyBillingEvent({ ...current, cancelAtPeriodEnd: true });
    case "resume":
      return applyBillingEvent({ ...current, cancelAtPeriodEnd: false });
    case "cancel_now":
      return applyBillingEvent({ ...base, type: "subscription.deleted" });
    case "simulate_renewal": {
      if (sub.cancelAtPeriodEnd) return applyBillingEvent({ ...base, type: "subscription.deleted" });
      const start = current.currentPeriodEnd;
      return applyBillingEvent({ ...current, status: "ACTIVE", currentPeriodStart: start, currentPeriodEnd: addInterval(start, sub.billingInterval ?? "MONTH") });
    }
    case "simulate_payment_failed":
      return applyBillingEvent({ ...current, status: "PAST_DUE" });
  }
}

// ─── Admin revenue overview ────────────────────────────────────────────────

export async function getRevenueSummary() {
  const subs = await systemDb.subscription.findMany({ include: { plan: true, compPlan: true } });
  const now = new Date();
  const mrrCents = subs.reduce((sum, s) => sum + monthlyRevenueCents(s, now), 0);
  const paying = subs.filter((s) => monthlyRevenueCents(s, now) > 0);
  const comped = subs.filter((s) => isCompActive(s, now));
  const pastDue = subs.filter((s) => s.status === "PAST_DUE" && !!s.stripeSubscriptionId);
  const byPlan = new Map<string, { name: string; paying: number; mrrCents: number }>();
  for (const s of paying) {
    const row = byPlan.get(s.planId) ?? { name: s.plan.name, paying: 0, mrrCents: 0 };
    row.paying += 1;
    row.mrrCents += monthlyRevenueCents(s, now);
    byPlan.set(s.planId, row);
  }
  return { mrrCents, arrCents: mrrCents * 12, payingCount: paying.length, compedCount: comped.length, pastDueCount: pastDue.length, byPlan: [...byPlan.values()].sort((a, b) => b.mrrCents - a.mrrCents) };
}
