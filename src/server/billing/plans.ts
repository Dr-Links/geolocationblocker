import { z } from "zod";
import type { BillingInterval, Plan } from "@prisma/client";
import { systemDb, withSystemTx } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/server/errors";
import { recordAudit } from "@/server/services/audit";
import { FREE_PLAN_KEY } from "./entitlements";
import { FEATURE_KEYS, LIMIT_KEYS, parseFeatures } from "./limits";
import { getBillingProvider, isMockPriceId } from "./providers";

/**
 * SUPER_ADMIN plan management. Admins own all prices and limits; the seed
 * only provides starting defaults.
 *
 * Price changes are append-only: a new provider price is created and becomes
 * current for NEW checkouts. Existing subscribers keep their old price
 * (grandfathered) until they change plan.
 */

const limit = z.coerce.number().int().min(-1, "Use -1 for unlimited").max(10_000_000);

export const planInputSchema = z.object({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,30}$/, "Lowercase letters, numbers and dashes (2-31 chars)"),
  name: z.string().trim().min(1, "Name is required").max(60),
  description: z.string().trim().max(500).optional().transform((v) => v || null),
  priceCents: z.coerce.number().int().min(0).max(10_000_000),
  currency: z.enum(["usd", "eur", "gbp", "cad", "aud"]).default("usd"),
  interval: z.enum(["MONTH", "YEAR"]),
  maxPostsPerMonth: limit,
  monthlyCredits: limit,
  maxSocialAccounts: limit,
  maxMembers: limit,
  features: z.object(Object.fromEntries(FEATURE_KEYS.map((k) => [k, z.boolean()])) as Record<(typeof FEATURE_KEYS)[number], z.ZodBoolean>),
  isActive: z.boolean(),
  isPublic: z.boolean(),
  sortOrder: z.coerce.number().int().min(0).max(1000),
});

export type PlanInput = z.input<typeof planInputSchema>;

function priceChanged(before: Pick<Plan, "priceCents" | "currency" | "interval">, after: { priceCents: number; currency: string; interval: BillingInterval }) {
  return before.priceCents !== after.priceCents || before.currency !== after.currency || before.interval !== after.interval;
}

/** Create a new provider price for the plan and make it current. Previous current price is archived. */
async function rotatePrice(plan: Plan, actorId: string) {
  const provider = getBillingProvider();
  const productId = await provider.upsertProduct({ id: plan.id, name: plan.name, description: plan.description, productId: plan.stripeProductId });
  const previous = await systemDb.planPrice.findMany({ where: { planId: plan.id, isCurrent: true } });

  let newPriceId: string | null = null;
  if (plan.priceCents > 0) {
    newPriceId = await provider.createPrice({
      productId,
      planId: plan.id,
      priceCents: plan.priceCents,
      currency: plan.currency,
      interval: plan.interval,
    });
  }

  await withSystemTx(async (tx) => {
    await tx.planPrice.updateMany({ where: { planId: plan.id, isCurrent: true }, data: { isCurrent: false } });
    if (newPriceId) {
      await tx.planPrice.create({
        data: { planId: plan.id, providerPriceId: newPriceId, priceCents: plan.priceCents, currency: plan.currency, interval: plan.interval, createdById: actorId },
      });
    }
    await tx.plan.update({ where: { id: plan.id }, data: { stripeProductId: productId, stripePriceId: newPriceId } });
  });

  // Archive at the provider last; existing subscriptions keep billing on archived prices.
  for (const p of previous) {
    if (p.providerPriceId !== newPriceId && (provider.name === "mock" || !isMockPriceId(p.providerPriceId))) {
      await provider.archivePrice(p.providerPriceId);
    }
  }
  return newPriceId;
}

export async function listPlansWithStats() {
  const plans = await systemDb.plan.findMany({
    orderBy: [{ sortOrder: "asc" }, { priceCents: "asc" }],
    include: { prices: { orderBy: { createdAt: "desc" } } },
  });
  const counts = await systemDb.subscription.groupBy({
    by: ["planId"],
    where: { stripeSubscriptionId: { not: null }, status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } },
    _count: { _all: true },
  });
  const compCounts = await systemDb.subscription.groupBy({ by: ["compPlanId"], where: { isComped: true }, _count: { _all: true } });
  return plans.map((p) => ({
    ...p,
    features: parseFeatures(p.features),
    paidSubscribers: counts.find((c) => c.planId === p.id)?._count._all ?? 0,
    compedWorkspaces: compCounts.find((c) => c.compPlanId === p.id)?._count._all ?? 0,
  }));
}

export async function createPlan(actorId: string, input: PlanInput) {
  const data = planInputSchema.parse(input);
  if (data.key === FREE_PLAN_KEY && data.priceCents !== 0) throw new ConflictError("The free plan must cost $0");
  if (await systemDb.plan.findUnique({ where: { key: data.key } })) throw new ConflictError(`A plan with key "${data.key}" already exists`);

  const plan = await systemDb.plan.create({ data: { ...data, features: data.features } });
  await rotatePrice(plan, actorId);
  await recordAudit({ action: "admin.plan.create", actorId, targetType: "Plan", targetId: plan.id, metadata: { ...data } });
  return systemDb.plan.findUniqueOrThrow({ where: { id: plan.id } });
}

export async function updatePlan(actorId: string, planId: string, input: PlanInput) {
  const data = planInputSchema.parse(input);
  const before = await systemDb.plan.findUnique({ where: { id: planId } });
  if (!before) throw new NotFoundError("Plan not found");
  if (data.key !== before.key) throw new ConflictError("A plan's key can't be changed");
  if (before.key === FREE_PLAN_KEY) {
    if (data.priceCents !== 0) throw new ConflictError("The free plan must cost $0 (it's the fallback for lapsed workspaces)");
    if (!data.isActive) throw new ConflictError("The free plan can't be deactivated");
  }

  const { key: _key, ...fields } = data;
  void _key;
  const plan = await systemDb.plan.update({ where: { id: planId }, data: { ...fields, features: fields.features } });

  const repriced = priceChanged(before, data) || (data.priceCents > 0 && !before.stripePriceId);
  let grandfathered = 0;
  if (repriced) {
    grandfathered = await systemDb.subscription.count({ where: { planId, stripeSubscriptionId: { not: null }, status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } } });
    await rotatePrice(plan, actorId);
  } else if (before.name !== data.name || before.description !== data.description) {
    await getBillingProvider().upsertProduct({ id: plan.id, name: plan.name, description: plan.description, productId: plan.stripeProductId });
  }

  const changes: Record<string, { from: unknown; to: unknown }> = Object.fromEntries(
    (["name", "description", "priceCents", "currency", "interval", ...LIMIT_KEYS, "isActive", "isPublic", "sortOrder"] as const)
      .filter((k) => before[k] !== data[k])
      .map((k) => [k, { from: before[k], to: data[k] }]),
  );
  if (JSON.stringify(parseFeatures(before.features)) !== JSON.stringify(data.features)) {
    changes.features = { from: parseFeatures(before.features), to: data.features };
  }
  await recordAudit({
    action: "admin.plan.update",
    actorId,
    targetType: "Plan",
    targetId: planId,
    metadata: JSON.parse(JSON.stringify({ changes, repriced, grandfatheredSubscribers: grandfathered })),
  });
  return { plan: await systemDb.plan.findUniqueOrThrow({ where: { id: planId } }), repriced, grandfathered };
}

/**
 * After adding Stripe keys: create real Stripe products/prices for every plan
 * whose current price is a mock price (or missing).
 */
export async function syncPlansToProvider(actorId: string) {
  const provider = getBillingProvider();
  const plans = await systemDb.plan.findMany();
  const synced: string[] = [];
  for (const plan of plans) {
    const needs =
      plan.priceCents > 0 && (!plan.stripePriceId || (provider.name === "stripe" && isMockPriceId(plan.stripePriceId)));
    const needsProduct = provider.name === "stripe" && (!plan.stripeProductId || plan.stripeProductId.startsWith("mock_"));
    if (needs || needsProduct) {
      await rotatePrice(needsProduct ? { ...plan, stripeProductId: null } : plan, actorId);
      synced.push(plan.key);
    }
  }
  await recordAudit({ action: "admin.plan.sync_provider", actorId, metadata: { provider: provider.name, synced } });
  return synced;
}
