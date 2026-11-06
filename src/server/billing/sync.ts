import { withSystemTx } from "@/lib/db";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/server/services/audit";
import { getFreePlan } from "./entitlements";
import type { BillingEvent } from "./types";

export class UnknownPriceError extends Error {}
export class UnknownWorkspaceError extends Error {}

export type ApplyResult = "applied" | "duplicate" | "stale";

/**
 * Mirror one provider event into our Subscription row. This is the ONLY code
 * that writes provider-driven subscription state, for both Stripe and the mock.
 *
 * - Idempotent: each event id is recorded in StripeEvent; replays are no-ops.
 * - Order-safe: events older than the last applied one are ignored.
 * - Never touches comp fields (admin-owned).
 * - Throws on unknown price/workspace, so Stripe retries instead of us silently dropping it.
 */
export async function applyBillingEvent(event: BillingEvent): Promise<ApplyResult> {
  return withSystemTx(async (tx) => {
    // INSERT ... ON CONFLICT DO NOTHING: a failed INSERT would abort the transaction.
    const claimed = await tx.stripeEvent.createMany({ data: [{ id: event.id, type: event.type }], skipDuplicates: true });
    if (claimed.count === 0) return "duplicate";

    const existing = await tx.subscription.findFirst({
      where: event.workspaceId
        ? { workspaceId: event.workspaceId }
        : { OR: [{ stripeSubscriptionId: event.subscriptionId }, { stripeCustomerId: event.customerId }] },
    });
    const workspaceId = event.workspaceId ?? existing?.workspaceId;
    if (!workspaceId) throw new UnknownWorkspaceError(`No workspace for ${event.type} ${event.subscriptionId}`);

    if (existing?.lastEventAt && existing.lastEventAt > event.occurredAt) {
      logger.warn({ eventId: event.id, workspaceId }, "ignoring out-of-order billing event");
      return "stale";
    }

    if (event.type === "subscription.deleted") {
      if (!existing || (existing.stripeSubscriptionId && existing.stripeSubscriptionId !== event.subscriptionId)) {
        // Deletion of a subscription we've since replaced: nothing to do.
        return "applied";
      }
      const free = await getFreePlan(tx);
      await tx.subscription.update({
        where: { id: existing.id },
        data: { status: "CANCELED", cancelAtPeriodEnd: false, planId: free.id, lastEventAt: event.occurredAt },
      });
      await recordAudit(
        { action: "billing.subscription.canceled", workspaceId, targetType: "Subscription", targetId: existing.id, metadata: { eventId: event.id } },
        tx,
      );
      return "applied";
    }

    const price = await tx.planPrice.findUnique({ where: { providerPriceId: event.priceId }, include: { plan: true } });
    if (!price) throw new UnknownPriceError(`Unknown price ${event.priceId}; is it mapped to a plan?`);

    const data = {
      planId: price.planId,
      status: event.status,
      stripeCustomerId: event.customerId,
      stripeSubscriptionId: event.subscriptionId,
      stripePriceId: event.priceId,
      priceCents: event.unitAmountCents ?? price.priceCents,
      billingInterval: event.interval ?? price.interval,
      currentPeriodStart: event.currentPeriodStart,
      currentPeriodEnd: event.currentPeriodEnd,
      cancelAtPeriodEnd: event.cancelAtPeriodEnd,
      lastEventAt: event.occurredAt,
    };
    const sub = await tx.subscription.upsert({
      where: { workspaceId },
      update: data,
      create: { workspaceId, ...data },
    });

    const changedPlan = existing?.planId !== price.planId;
    const changedStatus = existing?.status !== event.status;
    if (changedPlan || changedStatus || existing?.cancelAtPeriodEnd !== event.cancelAtPeriodEnd) {
      await recordAudit(
        {
          action: "billing.subscription.sync",
          workspaceId,
          targetType: "Subscription",
          targetId: sub.id,
          metadata: {
            eventId: event.id,
            plan: price.plan.key,
            status: event.status,
            cancelAtPeriodEnd: event.cancelAtPeriodEnd,
            previous: existing ? { planId: existing.planId, status: existing.status } : null,
          },
        },
        tx,
      );
    }
    return "applied";
  });
}
