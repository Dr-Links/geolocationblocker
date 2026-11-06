import type { BillingInterval, SubscriptionStatus } from "@prisma/client";

/**
 * Provider-agnostic billing events. Stripe webhooks and the mock provider both
 * produce these, and a single function (applyBillingEvent) mirrors them into the DB.
 */
export type BillingEvent =
  | {
      id: string; // provider event id (idempotency key)
      type: "subscription.sync";
      occurredAt: Date;
      workspaceId?: string;
      customerId: string;
      subscriptionId: string;
      priceId: string;
      unitAmountCents?: number | null;
      interval?: BillingInterval | null;
      status: SubscriptionStatus;
      currentPeriodStart: Date;
      currentPeriodEnd: Date;
      cancelAtPeriodEnd: boolean;
    }
  | {
      id: string;
      type: "subscription.deleted";
      occurredAt: Date;
      workspaceId?: string;
      customerId: string;
      subscriptionId: string;
    };

export interface CheckoutInput {
  workspaceId: string;
  userId: string;
  customerId?: string | null;
  customerEmail: string;
  priceId: string;
  planName: string;
  successUrl: string;
  cancelUrl: string;
}

export interface BillingProvider {
  readonly name: "stripe" | "mock";
  /** Create or update the product that represents a plan. Returns the product id. */
  upsertProduct(plan: { id: string; name: string; description: string | null; productId: string | null }): Promise<string>;
  /** Prices are immutable: always creates a new one. */
  createPrice(input: { productId: string; planId: string; priceCents: number; currency: string; interval: BillingInterval }): Promise<string>;
  /** Stop offering a price to new customers. Existing subscriptions keep billing at it. */
  archivePrice(priceId: string): Promise<void>;
  createCheckoutSession(input: CheckoutInput): Promise<{ url: string }>;
  createPortalSession(input: { customerId: string; workspaceId: string; userId: string; returnUrl: string }): Promise<{ url: string }>;
  cancelSubscription(subscriptionId: string, opts: { atPeriodEnd: boolean }): Promise<void>;
}
