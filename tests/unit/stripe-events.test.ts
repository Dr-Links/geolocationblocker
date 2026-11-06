import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { mapStripeStatus, stripeEventToBillingEvents, subscriptionToEvent } from "@/server/billing/stripe-events";

const subscription = (over: Record<string, unknown> = {}) =>
  ({
    id: "sub_123",
    object: "subscription",
    customer: "cus_123",
    status: "active",
    cancel_at_period_end: false,
    cancel_at: null,
    metadata: { workspaceId: "ws_abc" },
    items: {
      data: [{ price: { id: "price_pro", unit_amount: 4900, recurring: { interval: "month" } }, current_period_start: 1_780_000_000, current_period_end: 1_782_592_000 }],
    },
    ...over,
  }) as unknown as Stripe.Subscription;

describe("Stripe event mapping", () => {
  it("maps statuses", () => {
    expect(mapStripeStatus("active")).toBe("ACTIVE");
    expect(mapStripeStatus("past_due")).toBe("PAST_DUE");
    expect(mapStripeStatus("incomplete_expired")).toBe("INCOMPLETE");
    expect(mapStripeStatus("paused")).toBe("UNPAID");
  });

  it("maps a subscription, reading the period from the item (API ≥ 2025-03)", () => {
    const e = subscriptionToEvent("evt_1", 1_780_000_100, subscription());
    expect(e).toMatchObject({
      type: "subscription.sync", workspaceId: "ws_abc", customerId: "cus_123", subscriptionId: "sub_123",
      priceId: "price_pro", unitAmountCents: 4900, interval: "MONTH", status: "ACTIVE", cancelAtPeriodEnd: false,
    });
    if (e.type !== "subscription.sync") throw new Error();
    expect(e.currentPeriodStart.getTime()).toBe(1_780_000_000_000);
  });

  it("canceled subscriptions become deletions; cancel_at counts as cancelling", () => {
    expect(subscriptionToEvent("e", 1, subscription({ status: "canceled" })).type).toBe("subscription.deleted");
    const e = subscriptionToEvent("e", 1, subscription({ cancel_at: 1_790_000_000 }));
    expect(e.type === "subscription.sync" && e.cancelAtPeriodEnd).toBe(true);
  });

  it("checkout.session.completed re-fetches the subscription and uses client_reference_id", async () => {
    const event = {
      id: "evt_cs", type: "checkout.session.completed", created: 1_780_000_200,
      data: { object: { mode: "subscription", subscription: "sub_123", client_reference_id: "ws_from_checkout" } },
    } as unknown as Stripe.Event;
    const fetched: string[] = [];
    const [e] = await stripeEventToBillingEvents(event, async (id) => {
      fetched.push(id);
      return subscription({ metadata: {} });
    });
    expect(fetched).toEqual(["sub_123"]);
    expect(e).toMatchObject({ id: "evt_cs", workspaceId: "ws_from_checkout" });
  });

  it("invoice events resolve the subscription id from the new parent field", async () => {
    const event = {
      id: "evt_inv", type: "invoice.payment_failed", created: 1,
      data: { object: { parent: { subscription_details: { subscription: "sub_123" } } } },
    } as unknown as Stripe.Event;
    const [e] = await stripeEventToBillingEvents(event, async () => subscription({ status: "past_due" }));
    expect(e).toMatchObject({ status: "PAST_DUE" });
  });

  it("ignores unrelated events", async () => {
    expect(await stripeEventToBillingEvents({ id: "x", type: "charge.refunded", data: { object: {} } } as unknown as Stripe.Event, async () => subscription())).toEqual([]);
  });

  it("webhook signature verification accepts genuine and rejects forged payloads (offline)", () => {
    const stripe = new Stripe("sk_test_dummy");
    const secret = "whsec_test_secret";
    const payload = JSON.stringify({ id: "evt_sig", object: "event", type: "customer.subscription.updated", data: { object: {} } });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
    expect(stripe.webhooks.constructEvent(payload, header, secret).id).toBe("evt_sig");
    expect(() => stripe.webhooks.constructEvent(payload.replace("evt_sig", "evt_forged"), header, secret)).toThrow();
    expect(() => stripe.webhooks.constructEvent(payload, header, "whsec_other")).toThrow();
  });
});
