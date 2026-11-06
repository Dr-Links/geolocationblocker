import { NextResponse, type NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { getStripeProvider } from "@/server/billing/providers";
import { stripeEventToBillingEvents } from "@/server/billing/stripe-events";
import { applyBillingEvent } from "@/server/billing/sync";

export const dynamic = "force-dynamic";

/**
 * Stripe webhook endpoint. Verifies the signature on the RAW body, maps the
 * event, and mirrors it. Returns 5xx on processing errors so Stripe retries;
 * replays are harmless because applyBillingEvent is idempotent.
 */
export async function POST(req: NextRequest) {
  const stripeProvider = getStripeProvider();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeProvider || !secret) return NextResponse.json({ error: "Stripe is not configured" }, { status: 404 });

  const signature = req.headers.get("stripe-signature");
  const body = await req.text();
  let event;
  try {
    event = stripeProvider.stripe.webhooks.constructEvent(body, signature ?? "", secret);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "stripe webhook signature verification failed");
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    const events = await stripeEventToBillingEvents(event, (id) => stripeProvider.stripe.subscriptions.retrieve(id));
    const results = [];
    for (const e of events) results.push(await applyBillingEvent(e));
    logger.info({ stripeEvent: event.type, id: event.id, results }, "stripe webhook processed");
    return NextResponse.json({ received: true, results });
  } catch (err) {
    logger.error({ err, stripeEvent: event.type, id: event.id }, "stripe webhook processing failed");
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
