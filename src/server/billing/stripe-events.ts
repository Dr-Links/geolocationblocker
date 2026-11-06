import type Stripe from "stripe";
import type { BillingInterval, SubscriptionStatus } from "@prisma/client";
import type { BillingEvent } from "./types";

/** Stripe → our status enum. */
export function mapStripeStatus(s: Stripe.Subscription.Status): SubscriptionStatus {
  switch (s) {
    case "active":
      return "ACTIVE";
    case "trialing":
      return "TRIALING";
    case "past_due":
      return "PAST_DUE";
    case "canceled":
      return "CANCELED";
    case "unpaid":
    case "paused":
      return "UNPAID";
    default: // incomplete, incomplete_expired
      return "INCOMPLETE";
  }
}

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : v?.id ?? "");
const toDate = (unix: number | null | undefined) => new Date((unix ?? 0) * 1000);

/** Convert a Stripe subscription object into our provider-agnostic event. */
export function subscriptionToEvent(eventId: string, occurredAtUnix: number, sub: Stripe.Subscription): BillingEvent {
  const workspaceId = sub.metadata?.workspaceId || undefined;
  if (sub.status === "canceled" || sub.status === "incomplete_expired") {
    return { id: eventId, type: "subscription.deleted", occurredAt: toDate(occurredAtUnix), workspaceId, customerId: idOf(sub.customer), subscriptionId: sub.id };
  }
  const item = sub.items.data[0];
  if (!item) throw new Error(`Stripe subscription ${sub.id} has no items`);
  const interval: BillingInterval | null = item.price.recurring?.interval === "year" ? "YEAR" : item.price.recurring?.interval === "month" ? "MONTH" : null;
  // Since API 2025-03, billing periods live on subscription items.
  const periodStart = (item as { current_period_start?: number }).current_period_start ?? (sub as unknown as { current_period_start?: number }).current_period_start;
  const periodEnd = (item as { current_period_end?: number }).current_period_end ?? (sub as unknown as { current_period_end?: number }).current_period_end;
  return {
    id: eventId,
    type: "subscription.sync",
    occurredAt: toDate(occurredAtUnix),
    workspaceId,
    customerId: idOf(sub.customer),
    subscriptionId: sub.id,
    priceId: item.price.id,
    unitAmountCents: item.price.unit_amount,
    interval,
    status: mapStripeStatus(sub.status),
    currentPeriodStart: toDate(periodStart),
    currentPeriodEnd: toDate(periodEnd),
    cancelAtPeriodEnd: sub.cancel_at_period_end || !!sub.cancel_at,
  };
}

export const HANDLED_STRIPE_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
]);

/**
 * Turn a verified Stripe webhook event into zero or more BillingEvents.
 * For checkout/invoice events we re-fetch the subscription so we always mirror
 * Stripe's current truth rather than a partial payload.
 */
export async function stripeEventToBillingEvents(
  event: Stripe.Event,
  fetchSubscription: (id: string) => Promise<Stripe.Subscription>,
): Promise<BillingEvent[]> {
  if (!HANDLED_STRIPE_EVENTS.has(event.type)) return [];
  const obj = event.data.object as unknown as Record<string, unknown>;

  if (event.type.startsWith("customer.subscription.")) {
    return [subscriptionToEvent(event.id, event.created, obj as unknown as Stripe.Subscription)];
  }

  if (event.type === "checkout.session.completed") {
    const session = obj as unknown as Stripe.Checkout.Session;
    if (session.mode !== "subscription" || !session.subscription) return [];
    const sub = await fetchSubscription(idOf(session.subscription));
    const ev = subscriptionToEvent(event.id, event.created, sub);
    // client_reference_id is set server-side by us at checkout creation.
    if (!ev.workspaceId && session.client_reference_id) ev.workspaceId = session.client_reference_id;
    return [ev];
  }

  // invoice.paid / invoice.payment_failed
  const invoice = obj as unknown as { parent?: { subscription_details?: { subscription?: string | { id: string } } }; subscription?: string | { id: string } };
  const subId = idOf(invoice.parent?.subscription_details?.subscription ?? invoice.subscription);
  if (!subId) return [];
  return [subscriptionToEvent(event.id, event.created, await fetchSubscription(subId))];
}
