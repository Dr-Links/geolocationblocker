import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart } from "@/components/charts/bar-chart";
import { RateMeters } from "@/components/charts/rate-meters";
import { Stat } from "@/components/charts/stat";
import { systemDb } from "@/lib/db";
import { formatMoney } from "@/lib/format";
import { platformAnalytics } from "@/server/analytics";
import { getRevenueSummary } from "@/server/billing/checkout";
import { requireSuperAdmin } from "@/server/tenancy/context";

export const metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  await requireSuperAdmin();
  const [revenue, a, userCount, workspaceCount, suspended, expiredAccounts] = await Promise.all([
    getRevenueSummary(),
    platformAnalytics(30),
    systemDb.user.count(),
    systemDb.workspace.count(),
    systemDb.workspace.count({ where: { suspendedAt: { not: null } } }),
    systemDb.socialAccount.count({ where: { status: { in: ["EXPIRED", "ERROR"] } } }),
  ]);
  const sum = (d: { values: number[] }[]) => d.reduce((n, x) => n + x.values.reduce((a2, b) => a2 + b, 0), 0);

  return (
    <div className="grid grid-cols-1 gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Platform overview</h1>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="MRR" value={formatMoney(revenue.mrrCents)} hint={`ARR ${formatMoney(revenue.arrCents)}`} testId="mrr" />
        <Stat label="Paying · comped · past due" value={`${revenue.payingCount} · ${revenue.compedCount} · ${revenue.pastDueCount}`} />
        <Stat label="Users" value={userCount.toLocaleString("en-US")} hint={`+${sum(a.signups)} in 30 days`} testId="kpi-users" />
        <Stat label="Workspaces" value={workspaceCount.toLocaleString("en-US")} hint={suspended ? `${suspended} suspended` : undefined} />
        <Stat label="Posts published (30d)" value={sum(a.published).toLocaleString("en-US")} />
        <Stat label="AI generations (30d)" value={sum(a.generations).toLocaleString("en-US")} hint={`${a.creditsConsumed.toLocaleString("en-US")} credits used`} />
        <Stat label="Failed publishes (7d)" value={<Link href="/admin/ops" className="underline-offset-4 hover:underline">{a.failedPublishes7d}</Link>} />
        <Stat label="Accounts needing reconnect" value={<Link href="/admin/ops" className="underline-offset-4 hover:underline">{expiredAccounts}</Link>} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card><CardContent className="pt-6"><BarChart title="Sign-ups per day" data={a.signups} series={[{ key: "signups", label: "Sign-ups", color: "var(--series-1)" }]} testId="chart-signups" /></CardContent></Card>
        <Card><CardContent className="pt-6"><BarChart title="Posts published per day (per platform target)" data={a.published} series={[{ key: "published", label: "Published", color: "var(--series-1)" }]} testId="chart-published" /></CardContent></Card>
        <Card>
          <CardContent className="pt-6">
            <BarChart title="AI generations per day" data={a.generations} testId="chart-generations"
              series={[{ key: "TEXT", label: "Text", color: "var(--series-1)" }, { key: "IMAGE", label: "Image", color: "var(--series-2)" }, { key: "VIDEO", label: "Video", color: "var(--series-3)" }]} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Publish success by platform</CardTitle><CardDescription>Last 30 days, all workspaces</CardDescription></CardHeader>
          <CardContent><RateMeters rows={a.platforms} /></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Revenue by plan</CardTitle><CardDescription>Monthly recurring (yearly plans normalized), comped workspaces excluded</CardDescription></CardHeader>
        <CardContent className="grid gap-1 text-sm">
          {revenue.byPlan.length === 0 ? <span className="text-muted-foreground">No paying subscriptions yet.</span> : null}
          {revenue.byPlan.map((r) => <span key={r.name} className="tabular-nums">{r.name}: {r.paying} paying · {formatMoney(r.mrrCents)}/mo</span>)}
        </CardContent>
      </Card>
    </div>
  );
}
