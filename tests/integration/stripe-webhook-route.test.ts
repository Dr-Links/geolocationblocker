import Stripe from "stripe";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/webhooks/stripe/route";
import { db, systemDb } from "@/lib/db";
import { setBillingProviderForTests } from "@/server/billing/providers";
import { cleanupTestData, makeTenant, uniq } from "./fixtures";

const SECRET = "whsec_route_test";
const stripe = new Stripe("sk_test_dummy");
let restore: { key?: string; secret?: string };

function signed(event: object, secret = SECRET) {
  const payload = JSON.stringify(event);
  return new NextRequest("http://localhost/api/webhooks/stripe", {
    method: "POST",
    body: payload,
    headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret }), "content-type": "application/json" },
  });
}

beforeAll(async () => {
  await cleanupTestData();
  restore = { key: process.env.STRIPE_SECRET_KEY, secret: process.env.STRIPE_WEBHOOK_SECRET };
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy"; // no network: subscription events carry the subscription
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  setBillingProviderForTests(undefined);
});
afterAll(async () => {
  process.env.STRIPE_SECRET_KEY = restore.key ?? "";
  process.env.STRIPE_WEBHOOK_SECRET = restore.secret ?? "";
  setBillingProviderForTests(undefined);
  await cleanupTestData();
  await db.$disconnect();
});

describe("POST /api/webhooks/stripe", () => {
  it("applies a signed subscription event once; replays are no-ops; forged ones are rejected", async () => {
    const t = await makeTenant("wh-route");
    const priceId = `price_${uniq()}`;
    const plan = await systemDb.plan.create({
      data: { key: `wh-${uniq()}`, name: "WH Pro", priceCents: 4900, maxPostsPerMonth: 100, monthlyCredits: 100, maxSocialAccounts: 5, maxMembers: 3, stripePriceId: priceId, prices: { create: { providerPriceId: priceId, priceCents: 4900, interval: "MONTH" } } },
    });
    const now = Math.floor(Date.now() / 1000);
    const event = {
      id: `evt_${uniq()}`,
      object: "event",
      type: "customer.subscription.updated",
      created: now,
      data: {
        object: {
          id: `sub_${uniq()}`, object: "subscription", customer: `cus_${uniq()}`, status: "active", cancel_at_period_end: false, cancel_at: null,
          metadata: { workspaceId: t.workspace.id },
          items: { data: [{ price: { id: priceId, unit_amount: 4900, recurring: { interval: "month" } }, current_period_start: now, current_period_end: now + 30 * 86400 }] },
        },
      },
    };

    const res = await POST(signed(event));
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual(["applied"]);
    const sub = await systemDb.subscription.findUniqueOrThrow({ where: { workspaceId: t.workspace.id } });
    expect([sub.planId, sub.status, sub.priceCents]).toEqual([plan.id, "ACTIVE", 4900]);

    expect((await (await POST(signed(event))).json()).results).toEqual(["duplicate"]);

    const forged = await POST(signed({ ...event, id: `evt_${uniq()}` }, "whsec_attacker"));
    expect(forged.status).toBe(400);
    const unsigned = await POST(new NextRequest("http://localhost/api/webhooks/stripe", { method: "POST", body: JSON.stringify(event) }));
    expect(unsigned.status).toBe(400);
  });

  it("acknowledges events it doesn't handle", async () => {
    const res = await POST(signed({ id: `evt_${uniq()}`, object: "event", type: "customer.created", created: 1, data: { object: {} } }));
    expect([res.status, (await res.json()).results]).toEqual([200, []]);
  });
});
