import Stripe from "stripe";
import type { BillingInterval } from "@prisma/client";
import type { BillingProvider, CheckoutInput } from "../types";

/** Real Stripe adapter. Active only when STRIPE_SECRET_KEY is set. */
export class StripeBillingProvider implements BillingProvider {
  readonly name = "stripe" as const;
  readonly stripe: Stripe;

  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey, { appInfo: { name: "Postpilot" }, maxNetworkRetries: 2 });
  }

  async upsertProduct(plan: { id: string; name: string; description: string | null; productId: string | null }) {
    const fields = { name: plan.name, description: plan.description || undefined, metadata: { planId: plan.id } };
    if (plan.productId) {
      await this.stripe.products.update(plan.productId, fields);
      return plan.productId;
    }
    return (await this.stripe.products.create(fields)).id;
  }

  async createPrice(input: { productId: string; planId: string; priceCents: number; currency: string; interval: BillingInterval }) {
    const price = await this.stripe.prices.create({
      product: input.productId,
      unit_amount: input.priceCents,
      currency: input.currency,
      recurring: { interval: input.interval === "YEAR" ? "year" : "month" },
      metadata: { planId: input.planId },
    });
    await this.stripe.products.update(input.productId, { default_price: price.id });
    return price.id;
  }

  async archivePrice(priceId: string) {
    await this.stripe.prices.update(priceId, { active: false });
  }

  async createCheckoutSession(input: CheckoutInput) {
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: input.priceId, quantity: 1 }],
      ...(input.customerId ? { customer: input.customerId } : { customer_email: input.customerEmail }),
      client_reference_id: input.workspaceId,
      metadata: { workspaceId: input.workspaceId, userId: input.userId },
      subscription_data: { metadata: { workspaceId: input.workspaceId } },
      allow_promotion_codes: true,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return { url: session.url };
  }

  async createPortalSession(input: { customerId: string; returnUrl: string }) {
    const session = await this.stripe.billingPortal.sessions.create({ customer: input.customerId, return_url: input.returnUrl });
    return { url: session.url };
  }

  async cancelSubscription(subscriptionId: string, opts: { atPeriodEnd: boolean }) {
    if (opts.atPeriodEnd) await this.stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
    else await this.stripe.subscriptions.cancel(subscriptionId);
  }
}
