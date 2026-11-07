/**
 * Seed: plans, SUPER_ADMIN, a demo workspace with mock social accounts and sample posts.
 * Idempotent — safe to re-run. Run with `npm run db:seed`.
 */
import type { SocialPlatform } from "@prisma/client";
import { encryptSecret } from "../src/lib/crypto";
import { hashPassword } from "../src/lib/password";
import { db as rawDb, systemDb as db } from "../src/lib/db";

// The seed is trusted system code: it writes across tenants, so it uses systemDb (RLS bypass).

const PLANS = [
  { key: "free", name: "Free", priceCents: 0, maxPostsPerMonth: 10, monthlyCredits: 20, maxSocialAccounts: 2, maxMembers: 1,
    features: { video: false, byok: false, recurring: false }, sortOrder: 0 },
  { key: "starter", name: "Starter", priceCents: 1900, maxPostsPerMonth: 100, monthlyCredits: 200, maxSocialAccounts: 5, maxMembers: 2,
    features: { video: false, byok: true, recurring: true }, sortOrder: 1 },
  { key: "pro", name: "Pro", priceCents: 4900, maxPostsPerMonth: 500, monthlyCredits: 1000, maxSocialAccounts: 15, maxMembers: 5,
    features: { video: true, byok: true, recurring: true }, sortOrder: 2 },
  { key: "agency", name: "Agency", priceCents: 14900, maxPostsPerMonth: -1, monthlyCredits: 5000, maxSocialAccounts: 50, maxMembers: 25,
    features: { video: true, byok: true, recurring: true }, sortOrder: 3 },
];

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);

async function main() {
  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? "admin@example.com").toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";
  const demoPassword = process.env.SEED_DEMO_PASSWORD ?? "Demo12345!";

  // Plans are created once and then owned by the SUPER_ADMIN (Admin → Plans).
  // Re-seeding never overwrites prices or limits an admin has changed.
  for (const p of PLANS) {
    const existing = await db.plan.findUnique({ where: { key: p.key } });
    if (existing) continue;
    const plan = await db.plan.create({ data: { ...p, stripeProductId: `mock_prod_${p.key}` } });
    if (plan.priceCents > 0) {
      const priceId = `mock_price_${plan.id}_seed`;
      await db.planPrice.create({ data: { planId: plan.id, providerPriceId: priceId, priceCents: plan.priceCents, interval: plan.interval } });
      await db.plan.update({ where: { id: plan.id }, data: { stripePriceId: priceId } });
    }
  }
  const plans = Object.fromEntries((await db.plan.findMany()).map((p) => [p.key, p]));

  const admin = await db.user.upsert({
    where: { email: adminEmail },
    update: { platformRole: "SUPER_ADMIN" },
    create: { email: adminEmail, name: "Platform Admin", platformRole: "SUPER_ADMIN", passwordHash: await hashPassword(adminPassword) },
  });

  const demo = await db.user.upsert({
    where: { email: "demo@example.com" },
    update: {},
    create: { email: "demo@example.com", name: "Demo User", passwordHash: await hashPassword(demoPassword) },
  });

  // Rebuild the demo workspace from scratch so re-seeding gives a known state.
  await db.workspace.deleteMany({ where: { slug: "acme-coffee" } });
  const ws = await db.workspace.create({
    data: {
      name: "Acme Coffee",
      slug: "acme-coffee",
      timezone: "America/New_York",
      aiPreferences: { TEXT: { provider: "MOCK" }, IMAGE: { provider: "MOCK" }, VIDEO: { provider: "MOCK" } },
      memberships: {
        create: [
          { userId: demo.id, role: "WORKSPACE_ADMIN" },
          { userId: admin.id, role: "WORKSPACE_ADMIN" },
        ],
      },
      // Comped onto Pro by the platform admin; billed plan stays Free (no Stripe charge).
      subscription: {
        create: {
          planId: plans.free!.id,
          status: "ACTIVE",
          isComped: true,
          compPlanId: plans.pro!.id,
          compReason: "Seeded demo workspace",
          compedById: admin.id,
          compedAt: new Date(),
        },
      },
      // A few credits already spent this period, so the usage meter isn't empty.
      creditLedger: { create: { delta: -37, reason: "generation", note: "seed" } },
    },
  });

  const mockAccounts: { platform: SocialPlatform; handle: string; displayName: string }[] = [
    { platform: "X", handle: "@acmecoffee", displayName: "Acme Coffee" },
    { platform: "INSTAGRAM", handle: "@acme.coffee", displayName: "Acme Coffee" },
    { platform: "LINKEDIN", handle: "acme-coffee", displayName: "Acme Coffee Co." },
  ];
  const accounts = [];
  for (const a of mockAccounts) {
    accounts.push(
      await db.socialAccount.create({
        data: {
          workspaceId: ws.id,
          platform: a.platform,
          isMock: true,
          externalId: `mock-${a.platform.toLowerCase()}-1`,
          displayName: a.displayName,
          handle: a.handle,
          accessTokenEnc: encryptSecret(`mock-access-${a.platform}`),
          refreshTokenEnc: encryptSecret(`mock-refresh-${a.platform}`),
          tokenExpiresAt: hoursFromNow(24 * 60),
          scopes: ["mock.publish"],
          lastHealthCheckAt: new Date(),
        },
      }),
    );
  }
  const [x, ig, li] = accounts as [typeof accounts[number], typeof accounts[number], typeof accounts[number]];

  const posts = [
    { content: "Draft: our autumn menu is coming. Pumpkin cold brew? 🎃", status: "DRAFT" as const, targets: [x.id] },
    // Scheduled samples are valid for their platforms, so the real scheduler publishes them (Instagram needs media).
    { content: "Monday fuel ☕ 20% off all lattes before 9am. #MondayMotivation", status: "SCHEDULED" as const,
      targets: [x.id, li.id], schedule: { scheduledAt: hoursFromNow(2), timezone: "America/New_York" } },
    { content: "We're hiring baristas in Brooklyn! Apply via the link in our profile.", status: "SCHEDULED" as const,
      targets: [li.id, x.id], schedule: { scheduledAt: hoursFromNow(26), timezone: "America/New_York" } },
    { content: "Weekly roast drop — this week: Ethiopia Yirgacheffe.", status: "SCHEDULED" as const,
      targets: [x.id], schedule: { scheduledAt: hoursFromNow(72), timezone: "America/New_York", recurrenceRule: "FREQ=WEEKLY;BYDAY=FR" } },
    { content: "Thanks for 10k followers! 🙏", status: "PUBLISHED" as const, targets: [x.id], publishedAt: hoursFromNow(-48) },
    { content: "Behind the scenes at the roastery 🔥", status: "FAILED" as const, targets: [ig.id], error: "Mock: media aspect ratio rejected" },
  ];

  for (const p of posts) {
    await db.post.create({
      data: {
        workspaceId: ws.id,
        authorId: demo.id,
        content: p.content,
        status: p.status,
        publishedAt: p.publishedAt,
        schedule: p.schedule ? { create: p.schedule } : undefined,
        targets: {
          create: p.targets.map((socialAccountId) => ({
            socialAccountId,
            status: p.status === "PUBLISHED" ? "PUBLISHED" : p.status === "FAILED" ? "FAILED" : "PENDING",
            attempts: p.status === "FAILED" ? 3 : p.status === "PUBLISHED" ? 1 : 0,
            lastError: p.error,
            publishedAt: p.publishedAt,
            externalPostId: p.status === "PUBLISHED" ? `mock-post-${Math.random().toString(36).slice(2, 10)}` : undefined,
          })),
        },
      },
    });
  }

  // A second, unrelated tenant to demonstrate isolation: demo@ cannot see it.
  const other = await db.user.upsert({
    where: { email: "other@example.com" },
    update: {},
    create: { email: "other@example.com", name: "Other Owner", passwordHash: await hashPassword(demoPassword) },
  });
  await db.workspace.deleteMany({ where: { slug: "globex-bakery" } });
  await db.workspace.create({
    data: {
      name: "Globex Bakery",
      slug: "globex-bakery",
      memberships: { create: { userId: other.id, role: "WORKSPACE_ADMIN" } },
      subscription: { create: { planId: plans.free!.id } },
      posts: { create: [{ content: "Globex private draft: do not leak", authorId: other.id }] },
    },
  });

  await db.auditLog.create({ data: { action: "system.seed", actorId: admin.id, workspaceId: ws.id, metadata: { posts: posts.length } } });

  console.log(`Seeded:
  SUPER_ADMIN  ${adminEmail} / ${process.env.SEED_ADMIN_PASSWORD ? "(SEED_ADMIN_PASSWORD)" : adminPassword}
  Demo user    demo@example.com / ${process.env.SEED_DEMO_PASSWORD ? "(SEED_DEMO_PASSWORD)" : demoPassword}
  Other owner  other@example.com / (same as demo password)
  Workspaces   Acme Coffee (comped Pro): ${accounts.length} mock accounts, ${posts.length} posts
               Globex Bakery (Free): separate tenant, 1 private draft
  Plans        ${PLANS.map((p) => p.key).join(", ")}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => rawDb.$disconnect());
