import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import { UsageMeters } from "@/components/billing/usage-meters";
import { BarChart } from "@/components/charts/bar-chart";
import { RateMeters } from "@/components/charts/rate-meters";
import { Badge } from "@/components/ui/badge";
import { workspaceAnalytics } from "@/server/analytics";
import { withTenantTx } from "@/lib/db";
import { getEntitlements, getUsage } from "@/server/billing/entitlements";
import { getTenantContext } from "@/server/tenancy/context";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const ctx = await getTenantContext();
  const { db, workspaceId, user } = ctx;

  const [workspace, drafts, scheduled, published, accounts] = await Promise.all([
    db.workspace.findUniqueOrThrow({ where: { id: workspaceId } }),
    db.post.count({ where: { workspaceId, status: "DRAFT" } }),
    db.post.count({ where: { workspaceId, status: "SCHEDULED" } }),
    db.post.count({ where: { workspaceId, status: "PUBLISHED" } }),
    db.socialAccount.count({ where: { workspaceId, status: "CONNECTED" } }),
  ]);
  const [upcoming, recent, troubled, badAccounts, analytics] = await Promise.all([
    db.post.findMany({ where: { workspaceId, status: "SCHEDULED" }, orderBy: { schedule: { scheduledAt: "asc" } }, take: 5, include: { schedule: true, targets: { select: { socialAccount: { select: { platform: true } } } } } }),
    db.post.findMany({ where: { workspaceId, status: { in: ["PUBLISHED", "PARTIALLY_PUBLISHED"] } }, orderBy: { publishedAt: "desc" }, take: 5 }),
    db.post.findMany({ where: { workspaceId, status: { in: ["FAILED", "PARTIALLY_PUBLISHED"] }, updatedAt: { gte: new Date(Date.now() - 14 * 86_400_000) } }, orderBy: { updatedAt: "desc" }, take: 5 }),
    db.socialAccount.findMany({ where: { workspaceId, status: { in: ["EXPIRED", "ERROR"] } }, take: 5 }),
    workspaceAnalytics(workspaceId, 30),
  ]);
  const snippet = (c: string) => (c.length > 80 ? `${c.slice(0, 80)}…` : c || "(no text)");
  const when = (d: Date | null | undefined) => d?.toISOString().slice(0, 16).replace("T", " ") + " UTC";

  const { ent, usage } = await withTenantTx(workspaceId, async (tx) => {
    const ent = await getEntitlements(tx, workspaceId);
    return { ent, usage: await getUsage(tx, workspaceId, ent) };
  });

  const stats = [
    { label: "Drafts", value: drafts },
    { label: "Scheduled", value: scheduled },
    { label: "Published", value: published },
    { label: "Connected accounts", value: accounts },
  ];
  const isEmpty = stats.every((s) => s.value === 0);
  const plan = ent.plan;

  return (
    <div className="grid grid-cols-1 gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome{user.name ? `, ${user.name}` : ""}</h1>
        <p className="text-sm text-muted-foreground">
          {workspace.name}
          {plan ? ` · ${plan.name} plan` : ""}
          {ent.source === "comp" ? " (complimentary)" : ""}
          {` · you are ${ctx.role === "WORKSPACE_ADMIN" ? "an admin" : "a member"}`}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-2">
              <CardDescription>{s.label}</CardDescription>
              <CardTitle className="text-3xl tabular-nums" data-testid={`stat-${s.label.toLowerCase().replace(/\s+/g, "-")}`}>{s.value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Plan usage</CardTitle>
          <CardDescription><Link href="/dashboard/billing" className="underline underline-offset-4">View plans &amp; billing</Link></CardDescription>
        </CardHeader>
        <CardContent><UsageMeters ent={ent} usage={usage} /></CardContent>
      </Card>

      {troubled.length || badAccounts.length ? (
        <Card data-testid="needs-attention" className="border-amber-500/50">
          <CardHeader><CardTitle>Needs attention</CardTitle><CardDescription>Things that didn&apos;t go as planned recently.</CardDescription></CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {badAccounts.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-2">
                <Badge variant="destructive">{a.status.toLowerCase()}</Badge>
                <span>{a.platform} · {a.handle ?? a.displayName} needs to be reconnected.</span>
                <Link href="/dashboard/accounts" className="underline underline-offset-4">Accounts</Link>
              </div>
            ))}
            {troubled.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-2">
                <Badge variant="destructive">{p.status === "FAILED" ? "failed" : "partially published"}</Badge>
                <span className="min-w-0 break-words">{snippet(p.content)}</span>
                <Link href="/dashboard/posts?tab=failed" className="underline underline-offset-4">Review</Link>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Coming up</CardTitle><CardDescription><Link href="/dashboard/calendar" className="underline underline-offset-4">Open calendar</Link></CardDescription></CardHeader>
          <CardContent className="grid gap-2 text-sm" data-testid="upcoming-posts">
            {upcoming.length === 0 ? <span className="text-muted-foreground">Nothing scheduled. <Link href="/dashboard/compose" className="underline underline-offset-4">Write a post</Link></span> : null}
            {upcoming.map((p) => (
              <Link key={p.id} href={`/dashboard/compose?post=${p.id}`} className="grid gap-0.5 rounded-md border px-3 py-2 hover:bg-accent">
                <span className="min-w-0 break-words">{snippet(p.content)}</span>
                <span className="text-xs text-muted-foreground">{when(p.schedule?.scheduledAt)} · {[...new Set(p.targets.map((t) => t.socialAccount.platform))].join(", ")}{p.schedule?.recurrenceRule ? " · repeats" : ""}</span>
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Recently published</CardTitle><CardDescription><Link href="/dashboard/posts?tab=published" className="underline underline-offset-4">All posts</Link></CardDescription></CardHeader>
          <CardContent className="grid gap-2 text-sm" data-testid="recent-posts">
            {recent.length === 0 ? <span className="text-muted-foreground">Nothing published yet.</span> : null}
            {recent.map((p) => (
              <div key={p.id} className="grid gap-0.5 rounded-md border px-3 py-2">
                <span className="min-w-0 break-words">{snippet(p.content)}</span>
                <span className="text-xs text-muted-foreground">{when(p.publishedAt)}{p.status === "PARTIALLY_PUBLISHED" ? " · partially" : ""}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card><CardContent className="pt-6"><BarChart title="Published per day (per account), last 30 days" data={analytics.published} series={[{ key: "published", label: "Published", color: "var(--series-1)" }]} testId="ws-chart-published" /></CardContent></Card>
        <Card><CardContent className="pt-6"><BarChart title="AI generations per day, last 30 days" data={analytics.generations} testId="ws-chart-generations"
          series={[{ key: "TEXT", label: "Text", color: "var(--series-1)" }, { key: "IMAGE", label: "Image", color: "var(--series-2)" }, { key: "VIDEO", label: "Video", color: "var(--series-3)" }]} /></CardContent></Card>
      </div>
      {analytics.platforms.length ? (
        <Card>
          <CardHeader><CardTitle>Publish success by platform</CardTitle><CardDescription>Last 30 days</CardDescription></CardHeader>
          <CardContent><RateMeters rows={analytics.platforms} /></CardContent>
        </Card>
      ) : null}

      {isEmpty ? (
        <Card data-testid="empty-state">
          <CardHeader>
            <CardTitle>Nothing here yet</CardTitle>
            <CardDescription>Your workspace is ready. Connect a social account, then write and schedule your first post.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-4 text-sm">
            <Link href="/dashboard/accounts" className="underline underline-offset-4">Connect an account</Link>
            <Link href="/dashboard/compose" className="underline underline-offset-4">Write a post</Link>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
