import { randomBytes } from "node:crypto";
import type { BillingInterval } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { signToken } from "@/lib/signed-token";
import type { BillingProvider, CheckoutInput } from "../types";

/**
 * Default provider when STRIPE_SECRET_KEY is unset. Checkout and the customer
 * portal are local pages (/billing/mock/*) whose actions emit the same
 * BillingEvents a Stripe webhook would, through applyBillingEvent.
 */

export const MOCK_CHECKOUT_PURPOSE = "mock-checkout";
export const MOCK_PORTAL_PURPOSE = "mock-portal";

export interface MockCheckoutToken {
  w: string; // workspaceId
  u: string; // userId
  p: string; // priceId
}
export interface MockPortalToken {
  w: string;
  u: string;
}

/** Test cards, mirroring Stripe's: 4242… succeeds, 4000…0002 is declined. */
export const MOCK_CARDS = { success: "4242424242424242", declined: "4000000000000002" } as const;

const rid = () => randomBytes(8).toString("hex");
const appUrl = () => process.env.APP_URL ?? "http://localhost:3000";

export function addInterval(from: Date, interval: BillingInterval) {
  const d = new Date(from);
  if (interval === "YEAR") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

export function mockEventId() {
  return `mock_evt_${rid()}`;
}

export class MockBillingProvider implements BillingProvider {
  readonly name = "mock" as const;

  async upsertProduct(plan: { id: string; productId: string | null }) {
    return plan.productId ?? `mock_prod_${plan.id}`;
  }

  async createPrice(input: { planId: string }) {
    return `mock_price_${input.planId}_${rid()}`;
  }

  async archivePrice() {}

  async createCheckoutSession(input: CheckoutInput) {
    const t = signToken<MockCheckoutToken>({ w: input.workspaceId, u: input.userId, p: input.priceId }, MOCK_CHECKOUT_PURPOSE, 60 * 60);
    return { url: `${appUrl()}/billing/mock/checkout?t=${encodeURIComponent(t)}` };
  }

  async createPortalSession(input: { workspaceId: string; userId: string }) {
    const t = signToken<MockPortalToken>({ w: input.workspaceId, u: input.userId }, MOCK_PORTAL_PURPOSE, 60 * 60);
    return { url: `${appUrl()}/billing/mock/portal?t=${encodeURIComponent(t)}` };
  }

  async cancelSubscription(subscriptionId: string, opts: { atPeriodEnd: boolean }) {
    const { applyBillingEvent } = await import("../sync");
    const sub = await systemDb.subscription.findUnique({ where: { stripeSubscriptionId: subscriptionId } });
    if (!sub?.stripeCustomerId) return;
    if (!opts.atPeriodEnd) {
      await applyBillingEvent({
        id: mockEventId(), type: "subscription.deleted", occurredAt: new Date(),
        workspaceId: sub.workspaceId, customerId: sub.stripeCustomerId, subscriptionId,
      });
      return;
    }
    await applyBillingEvent({
      id: mockEventId(), type: "subscription.sync", occurredAt: new Date(),
      workspaceId: sub.workspaceId, customerId: sub.stripeCustomerId, subscriptionId,
      priceId: sub.stripePriceId!, status: sub.status, cancelAtPeriodEnd: true,
      currentPeriodStart: sub.currentPeriodStart ?? new Date(), currentPeriodEnd: sub.currentPeriodEnd ?? new Date(),
    });
  }
}
