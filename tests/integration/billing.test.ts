import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, systemDb } from "@/lib/db";
import { ConflictError, ForbiddenError, LimitExceededError } from "@/server/errors";
import { completeMockCheckout, getRevenueSummary, openBillingPortal, runMockPortalAction, startCheckout } from "@/server/billing/checkout";
import { compWorkspace, createCompedAccount, removeComp } from "@/server/billing/comp";
import { consumeCredits, getEntitlements, getUsage } from "@/server/billing/entitlements";
import { createPlan, updatePlan, type PlanInput } from "@/server/billing/plans";
import { setBillingProviderForTests } from "@/server/billing/providers";
import { MOCK_CARDS } from "@/server/billing/providers/mock";
import { applyBillingEvent, UnknownPriceError } from "@/server/billing/sync";
import { createInvitation } from "@/server/services/members";
import { acceptInvitation } from "@/server/services/members";
import { registerUser } from "@/server/services/users";
import { addMember, cleanupTestData, ctxFor, makeTenant, testEmail } from "./fixtures";

const tag = () => randomBytes(3).toString("hex");
let adminId: string;

const planInput = (over: Partial<PlanInput> = {}): PlanInput => ({
  key: `itest-${tag()}`,
  name: "Test Pro",
  description: "for tests",
  priceCents: 4900,
  currency: "usd",
  interval: "MONTH",
  maxPostsPerMonth: 100,
  monthlyCredits: 10,
  maxSocialAccounts: 3,
  maxMembers: 3,
  features: { video: true, byok: true, recurring: true },
  isActive: true,
  isPublic: true,
  sortOrder: 50,
  ...over,
});

async function cleanupPlans() {
  const plans = await systemDb.plan.findMany({ where: { key: { startsWith: "itest-" } }, select: { id: true } });
  const ids = plans.map((p) => p.id);
  await systemDb.subscription.deleteMany({ where: { OR: [{ planId: { in: ids } }, { compPlanId: { in: ids } }] } });
  await systemDb.plan.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  setBillingProviderForTests(undefined); // mock (no STRIPE_SECRET_KEY in tests)
  delete process.env.STRIPE_SECRET_KEY;
  await cleanupTestData();
  await cleanupPlans();
  await systemDb.plan.upsert({
    where: { key: "free" },
    update: {},
    create: { key: "free", name: "Free", maxPostsPerMonth: 10, monthlyCredits: 20, maxSocialAccounts: 2, maxMembers: 1 },
  });
  adminId = (await systemDb.user.create({ data: { email: testEmail("superadmin"), platformRole: "SUPER_ADMIN" } })).id;
});
afterAll(async () => {
  await cleanupTestData();
  await cleanupPlans();
  await db.$disconnect();
});

/** Workspace admin context with a user email, as the app builds it. */
async function adminCtxFor(t: Awaited<ReturnType<typeof makeTenant>>) {
  return { ...ctxFor(t.admin.id, t.workspace.id, "WORKSPACE_ADMIN"), user: { email: t.admin.email } };
}
const tokenOf = (url: string) => decodeURIComponent(new URL(url).searchParams.get("t")!);

describe("admin plan management (admin sets prices)", () => {
  it("creating a paid plan creates a current provider price", async () => {
    const plan = await createPlan(adminId, planInput());
    expect(plan.stripePriceId).toMatch(/^mock_price_/);
    const prices = await systemDb.planPrice.findMany({ where: { planId: plan.id } });
    expect(prices).toHaveLength(1);
    expect(prices[0]).toMatchObject({ priceCents: 4900, isCurrent: true });
  });

  it("changing the price rotates to a new price and grandfathers existing subscribers", async () => {
    const plan = await createPlan(adminId, planInput());
    const oldPriceId = plan.stripePriceId!;
    const T = await makeTenant("grandfather");

    // A customer subscribes at $49.
    const { url } = await startCheckout(await adminCtxFor(T), plan.id);
    await completeMockCheckout(tokenOf(url), T.admin.id, MOCK_CARDS.success);

    // Admin raises the price to $59.
    const { repriced, grandfathered, plan: after } = await updatePlan(adminId, plan.id, planInput({ key: plan.key, priceCents: 5900 }));
    expect(repriced).toBe(true);
    expect(grandfathered).toBe(1);
    expect(after.stripePriceId).not.toBe(oldPriceId);
    expect(after.priceCents).toBe(5900);

    const prices = await systemDb.planPrice.findMany({ where: { planId: plan.id }, orderBy: { createdAt: "asc" } });
    expect(prices.map((p) => [p.priceCents, p.isCurrent])).toEqual([[4900, false], [5900, true]]);

    // Existing subscriber keeps $49 and still maps to the plan when their old price renews.
    const sub = await systemDb.subscription.findUniqueOrThrow({ where: { workspaceId: T.workspace.id } });
    expect(sub).toMatchObject({ planId: plan.id, stripePriceId: oldPriceId, priceCents: 4900 });
    const portal = await openBillingPortal(ctxFor(T.admin.id, T.workspace.id, "WORKSPACE_ADMIN"));
    await runMockPortalAction(tokenOf(portal.url), T.admin.id, { kind: "simulate_renewal" });
    expect((await systemDb.subscription.findUniqueOrThrow({ where: { workspaceId: T.workspace.id } })).priceCents).toBe(4900);

    // New customers pay the new price.
    const T2 = await makeTenant("newprice");
    const c2 = await startCheckout(await adminCtxFor(T2), plan.id);
    await completeMockCheckout(tokenOf(c2.url), T2.admin.id, MOCK_CARDS.success);
    expect(await systemDb.subscription.findUniqueOrThrow({ where: { workspaceId: T2.workspace.id } })).toMatchObject({ priceCents: 5900 });

    const audit = await systemDb.auditLog.findFirstOrThrow({ where: { action: "admin.plan.update", targetId: plan.id } });
    expect(audit.metadata).toMatchObject({ repriced: true, grandfatheredSubscribers: 1, changes: { priceCents: { from: 4900, to: 5900 } } });
  });

  it("changing limits only does not create a new price", async () => {
    const plan = await createPlan(adminId, planInput());
    const { repriced, plan: after } = await updatePlan(adminId, plan.id, planInput({ key: plan.key, maxSocialAccounts: 99 }));
    expect(repriced).toBe(false);
    expect(after.stripePriceId).toBe(plan.stripePriceId);
    expect(after.maxSocialAccounts).toBe(99);
  });

  it("guards: key is immutable, free plan stays $0 and active, keys are unique", async () => {
    const plan = await createPlan(adminId, planInput());
    await expect(updatePlan(adminId, plan.id, planInput({ key: `${plan.key}-x` }))).rejects.toBeInstanceOf(ConflictError);
    await expect(createPlan(adminId, planInput({ key: plan.key }))).rejects.toBeInstanceOf(ConflictError);
    const free = await systemDb.plan.findUniqueOrThrow({ where: { key: "free" } });
    const freeInput = planInput({ key: "free", priceCents: 0, maxPostsPerMonth: free.maxPostsPerMonth, monthlyCredits: free.monthlyCredits, maxSocialAccounts: free.maxSocialAccounts, maxMembers: free.maxMembers });
    await expect(updatePlan(adminId, free.id, { ...freeInput, priceCents: 100 })).rejects.toBeInstanceOf(ConflictError);
    await expect(updatePlan(adminId, free.id, { ...freeInput, isActive: false })).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects invalid input", async () => {
    await expect(createPlan(adminId, planInput({ priceCents: -5 }))).rejects.toThrow();
    await expect(createPlan(adminId, planInput({ maxMembers: -2 }))).rejects.toThrow();
    await expect(createPlan(adminId, planInput({ key: "Bad Key!" }))).rejects.toThrow();
  });
});

describe("applyBillingEvent (shared by Stripe webhooks and the mock)", () => {
  it("is idempotent, ignores stale events, and rejects unknown prices without recording them", async () => {
    const plan = await createPlan(adminId, planInput());
    const T = await makeTenant("events");
    const base = {
      type: "subscription.sync" as const, workspaceId: T.workspace.id, customerId: `cus_${tag()}`, subscriptionId: `sub_${tag()}`,
      priceId: plan.stripePriceId!, status: "ACTIVE" as const, currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000), cancelAtPeriodEnd: false,
    };
    const id = `evt_${tag()}`;
    expect(await applyBillingEvent({ ...base, id, occurredAt: new Date(2030, 0, 2) })).toBe("applied");
    expect(await applyBillingEvent({ ...base, id, occurredAt: new Date(2030, 0, 2) })).toBe("duplicate");
    // An older event arriving late must not roll state back.
    expect(await applyBillingEvent({ ...base, id: `evt_${tag()}`, occurredAt: new Date(2030, 0, 1), status: "PAST_DUE" })).toBe("stale");
    expect((await systemDb.subscription.findUniqueOrThrow({ where: { workspaceId: T.workspace.id } })).status).toBe("ACTIVE");

    const badId = `evt_${tag()}`;
    await expect(applyBillingEvent({ ...base, id: badId, occurredAt: new Date(2030, 0, 3), priceId: "price_unknown" })).rejects.toBeInstanceOf(UnknownPriceError);
    // Rolled back, so Stripe's retry (after the admin fixes the mapping) will be processed.
    expect(await systemDb.stripeEvent.count({ where: { id: badId } })).toBe(0);
  });

  it("deletion cancels and reverts to free entitlements", async () => {
    const plan = await createPlan(adminId, planInput());
    const T = await makeTenant("deleted");
    const { url } = await startCheckout(await adminCtxFor(T), plan.id);
    await completeMockCheckout(tokenOf(url), T.admin.id, MOCK_CARDS.success);
    expect((await getEntitlements(systemDb as never, T.workspace.id)).plan.key).toBe(plan.key);

    const portal = await openBillingPortal(ctxFor(T.admin.id, T.workspace.id, "WORKSPACE_ADMIN"));
    await runMockPortalAction(tokenOf(portal.url), T.admin.id, { kind: "cancel_now" });
    const ent = await getEntitlements(systemDb as never, T.workspace.id);
    expect(ent.subscription?.status).toBe("CANCELED");
    expect(ent.plan.key).toBe("free");
  });
});

describe("checkout + portal (mock provider)", () => {
  it("full lifecycle: declined card → success → switch → cancel at period end → renewal ends it", async () => {
    const starter = await createPlan(adminId, planInput({ priceCents: 1900, name: "Test Starter" }));
    const pro = await createPlan(adminId, planInput({ priceCents: 4900 }));
    const T = await makeTenant("lifecycle");
    const ctx = await adminCtxFor(T);

    const { url } = await startCheckout(ctx, starter.id);
    expect(url).toContain("/billing/mock/checkout?t=");
    await expect(completeMockCheckout(tokenOf(url), T.admin.id, MOCK_CARDS.declined)).rejects.toThrow(/declined/);
    expect(await systemDb.subscription.count({ where: { workspaceId: T.workspace.id } })).toBe(0);

    await completeMockCheckout(tokenOf(url), T.admin.id, "4242 4242 4242 4242");
    let sub = await systemDb.subscription.findUniqueOrThrow({ where: { workspaceId: T.workspace.id } });
    expect(sub).toMatchObject({ planId: starter.id, status: "ACTIVE", priceCents: 1900 });

    // Already subscribed: "checkout" for another plan goes to the portal instead (prorated change).
    const again = await startCheckout(ctx, pro.id);
    expect(again.url).toContain("/billing/mock/portal?t=");

    const p = tokenOf(again.url);
    await runMockPortalAction(p, T.admin.id, { kind: "switch", planId: pro.id });
    sub = await systemDb.subscription.findUniqueOrThrow({ where: { workspaceId: T.workspace.id } });
    expect(sub).toMatchObject({ planId: pro.id, priceCents: 4900 });

    await runMockPortalAction(p, T.admin.id, { kind: "simulate_payment_failed" });
    expect((await getEntitlements(systemDb as never, T.workspace.id)).source).toBe("paid"); // grace

    await runMockPortalAction(p, T.admin.id, { kind: "cancel_at_period_end" });
    expect((await systemDb.subscription.findUniqueOrThrow({ where: { workspaceId: T.workspace.id } })).cancelAtPeriodEnd).toBe(true);
    await runMockPortalAction(p, T.admin.id, { kind: "simulate_renewal" });
    expect((await systemDb.subscription.findUniqueOrThrow({ where: { workspaceId: T.workspace.id } })).status).toBe("CANCELED");
  });

  it("only workspace admins can check out; mock links are bound to the user", async () => {
    const plan = await createPlan(adminId, planInput());
    const T = await makeTenant("perm");
    const { user } = await addMember(T.workspace.id);
    await expect(startCheckout({ ...ctxFor(user.id, T.workspace.id, "MEMBER"), user: { email: user.email } }, plan.id)).rejects.toBeInstanceOf(ForbiddenError);

    const { url } = await startCheckout(await adminCtxFor(T), plan.id);
    await expect(completeMockCheckout(tokenOf(url), user.id, MOCK_CARDS.success)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(completeMockCheckout(tokenOf(url).slice(0, -2) + "xx", T.admin.id, MOCK_CARDS.success)).rejects.toThrow(/expired/);
  });

  it("inactive/hidden/free plans can't be checked out; comped workspaces don't need to pay", async () => {
    const T = await makeTenant("guards");
    const ctx = await adminCtxFor(T);
    const hidden = await createPlan(adminId, planInput({ isPublic: false }));
    await expect(startCheckout(ctx, hidden.id)).rejects.toThrow(/isn't available/);
    const free = await systemDb.plan.findUniqueOrThrow({ where: { key: "free" } });
    await expect(startCheckout(ctx, free.id)).rejects.toBeInstanceOf(ConflictError);

    const pro = await createPlan(adminId, planInput());
    await compWorkspace(adminId, T.workspace.id, { planId: pro.id, reason: "partner" });
    await expect(startCheckout(ctx, pro.id)).rejects.toThrow(/comped/);
  });
});

describe("comping", () => {
  it("full comp grants the plan; Stripe sync never removes it; uncomp reverts", async () => {
    const pro = await createPlan(adminId, planInput({ maxSocialAccounts: 15 }));
    const starter = await createPlan(adminId, planInput({ priceCents: 1900, maxSocialAccounts: 5 }));
    const T = await makeTenant("comp");

    // Paying on Starter…
    const { url } = await startCheckout(await adminCtxFor(T), starter.id);
    await completeMockCheckout(tokenOf(url), T.admin.id, MOCK_CARDS.success);
    // …then comped onto Pro.
    await compWorkspace(adminId, T.workspace.id, { planId: pro.id, reason: "Influencer partnership" });
    expect((await getEntitlements(systemDb as never, T.workspace.id)).limits.maxSocialAccounts).toBe(15);

    // A later Stripe/mock event keeps the comp intact.
    const portal = await openBillingPortal(ctxFor(T.admin.id, T.workspace.id, "WORKSPACE_ADMIN"));
    await runMockPortalAction(tokenOf(portal.url), T.admin.id, { kind: "simulate_renewal" });
    const ent = await getEntitlements(systemDb as never, T.workspace.id);
    expect(ent.source).toBe("comp");
    expect(ent.subscription?.compReason).toBe("Influencer partnership");

    await removeComp(adminId, T.workspace.id, "partnership ended");
    const after = await getEntitlements(systemDb as never, T.workspace.id);
    expect(after).toMatchObject({ source: "paid", plan: { id: starter.id } });
    expect(await systemDb.auditLog.count({ where: { workspaceId: T.workspace.id, action: { in: ["admin.workspace.comp", "admin.workspace.uncomp"] } } })).toBe(2);
  });

  it("partial comp: base plan + overrides; optional expiry", async () => {
    const T = await makeTenant("partial");
    const free = await systemDb.plan.findUniqueOrThrow({ where: { key: "free" } });
    await compWorkspace(adminId, T.workspace.id, {
      planId: free.id,
      reason: "nonprofit",
      overrides: { limits: { maxSocialAccounts: 10 }, features: { video: true } },
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const ent = await getEntitlements(systemDb as never, T.workspace.id);
    expect(ent.limits.maxSocialAccounts).toBe(10);
    expect(ent.limits.maxPostsPerMonth).toBe(free.maxPostsPerMonth);
    expect(ent.features.video).toBe(true);
  });

  it("requires a reason and a future expiry", async () => {
    const T = await makeTenant("compval");
    const free = await systemDb.plan.findUniqueOrThrow({ where: { key: "free" } });
    await expect(compWorkspace(adminId, T.workspace.id, { planId: free.id, reason: "" })).rejects.toThrow();
    await expect(compWorkspace(adminId, T.workspace.id, { planId: free.id, reason: "ok reason", expiresAt: new Date(Date.now() - 1000) })).rejects.toThrow(/future/);
  });

  it("create a comped account for a new person: they sign up via the link and own the workspace", async () => {
    const pro = await createPlan(adminId, planInput());
    const email = testEmail("comped-owner");
    const res = await createCompedAccount(adminId, { ownerEmail: email, workspaceName: "Comped Co", planId: pro.id, reason: "launch partner" });
    expect(res.existingUser).toBe(false);
    expect(res.inviteUrl).toContain("/invite/");

    const { user, workspace } = await registerUser({ name: "Owner", email, password: "longpassword1", inviteToken: res.inviteUrl!.split("/invite/")[1]! });
    expect(workspace.id).toBe(res.workspace.id);
    const m = await systemDb.membership.findUniqueOrThrow({ where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } } });
    expect(m.role).toBe("WORKSPACE_ADMIN");
    expect((await getEntitlements(systemDb as never, workspace.id)).source).toBe("comp");
  });

  it("create a comped account for an existing user adds them immediately", async () => {
    const pro = await createPlan(adminId, planInput());
    const existing = await systemDb.user.create({ data: { email: testEmail("existing") } });
    const res = await createCompedAccount(adminId, { ownerEmail: existing.email, workspaceName: "Existing Co", planId: pro.id, reason: "support" });
    expect(res).toMatchObject({ existingUser: true, inviteUrl: null });
    expect(await systemDb.membership.count({ where: { userId: existing.id, workspaceId: res.workspace.id, role: "WORKSPACE_ADMIN" } })).toBe(1);
  });
});

describe("usage limits", () => {
  it("member seats: free plan blocks invites; comp override raises the cap; re-invite reuses the seat", async () => {
    const T = await makeTenant("seats"); // admin = 1 member; free plan maxMembers = 1
    const ctx = ctxFor(T.admin.id, T.workspace.id, "WORKSPACE_ADMIN");
    const free = await systemDb.plan.findUniqueOrThrow({ where: { key: "free" } });
    if (free.maxMembers === 1) {
      await expect(createInvitation(ctx, { email: testEmail("blocked") })).rejects.toBeInstanceOf(LimitExceededError);
    }
    await compWorkspace(adminId, T.workspace.id, { planId: free.id, reason: "seats test", overrides: { limits: { maxMembers: 3 } } });
    const e1 = testEmail("seat1");
    await createInvitation(ctx, { email: e1 });
    await createInvitation(ctx, { email: testEmail("seat2") });
    await expect(createInvitation(ctx, { email: testEmail("seat3") })).rejects.toThrow(/allows 3 members/);
    await createInvitation(ctx, { email: e1 }); // re-invite: same seat

    const usage = await getUsage(systemDb as never, T.workspace.id, await getEntitlements(systemDb as never, T.workspace.id));
    expect(usage).toMatchObject({ members: 1, pendingInvites: 2, maxMembers: 3 });
  });

  it("accepting an invite re-checks seats if the plan was downgraded meanwhile", async () => {
    const T = await makeTenant("downgrade");
    const free = await systemDb.plan.findUniqueOrThrow({ where: { key: "free" } });
    await compWorkspace(adminId, T.workspace.id, { planId: free.id, reason: "downgrade test", overrides: { limits: { maxMembers: 2 } } });
    const email = testEmail("late");
    const { url } = await createInvitation(ctxFor(T.admin.id, T.workspace.id, "WORKSPACE_ADMIN"), { email });
    await removeComp(adminId, T.workspace.id);
    const user = await systemDb.user.create({ data: { email } });
    const run = acceptInvitation({ userId: user.id, email, token: url.split("/invite/")[1]! });
    if (free.maxMembers <= 1) await expect(run).rejects.toBeInstanceOf(LimitExceededError);
    else await run;
  });

  it("credits: concurrent spending can never exceed the allowance", async () => {
    const plan = await createPlan(adminId, planInput({ monthlyCredits: 10 }));
    const T = await makeTenant("credits");
    await compWorkspace(adminId, T.workspace.id, { planId: plan.id, reason: "credits test" });

    const results = await Promise.allSettled(Array.from({ length: 25 }, () => consumeCredits(T.workspace.id, 1)));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(10);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof LimitExceededError)).toBe(true);

    const usage = await getUsage(systemDb as never, T.workspace.id, await getEntitlements(systemDb as never, T.workspace.id));
    expect(usage.creditsUsed).toBe(10);
  });

  it("credits: unlimited plans never block", async () => {
    const plan = await createPlan(adminId, planInput({ monthlyCredits: -1 }));
    const T = await makeTenant("unlimited");
    await compWorkspace(adminId, T.workspace.id, { planId: plan.id, reason: "unlimited" });
    const { remaining } = await consumeCredits(T.workspace.id, 5000);
    expect(remaining).toBe(Number.POSITIVE_INFINITY);
  });

  it("credit ledger stays tenant-isolated", async () => {
    const A = await makeTenant("ledger-a");
    const B = await makeTenant("ledger-b");
    const plan = await createPlan(adminId, planInput({ monthlyCredits: 100 }));
    await compWorkspace(adminId, A.workspace.id, { planId: plan.id, reason: "ledger test" });
    await consumeCredits(A.workspace.id, 7);
    const { tenantDb } = await import("@/lib/db");
    expect(await tenantDb(B.workspace.id).creditLedgerEntry.count({ where: { workspaceId: A.workspace.id } })).toBe(0);
  });
});

describe("revenue summary", () => {
  it("counts paying subscriptions (MRR) and excludes comped ones", async () => {
    const before = await getRevenueSummary();
    const plan = await createPlan(adminId, planInput({ priceCents: 10000 }));
    const T = await makeTenant("revenue");
    const { url } = await startCheckout(await adminCtxFor(T), plan.id);
    await completeMockCheckout(tokenOf(url), T.admin.id, MOCK_CARDS.success);
    const after = await getRevenueSummary();
    expect(after.mrrCents - before.mrrCents).toBe(10000);
    expect(after.payingCount - before.payingCount).toBe(1);

    await compWorkspace(adminId, T.workspace.id, { planId: plan.id, reason: "now comped" });
    const comped = await getRevenueSummary();
    expect(comped.mrrCents).toBe(before.mrrCents);
    expect(comped.compedCount - before.compedCount).toBe(1);
  });
});
