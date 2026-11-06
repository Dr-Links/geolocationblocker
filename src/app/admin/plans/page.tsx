import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatLimit, formatMoney, intervalLabel } from "@/lib/format";
import { listPlansWithStats } from "@/server/billing/plans";
import { getBillingProvider, isMockPriceId } from "@/server/billing/providers";
import { requireSuperAdmin } from "@/server/tenancy/context";
import { SyncPlansButton } from "./sync-button";

export const metadata = { title: "Plans" };
export const dynamic = "force-dynamic";

export default async function AdminPlansPage() {
  await requireSuperAdmin();
  const plans = await listPlansWithStats();
  const provider = getBillingProvider().name;
  const needsSync = provider === "stripe" && plans.some((p) => p.priceCents > 0 && (!p.stripePriceId || isMockPriceId(p.stripePriceId)));

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Plans &amp; pricing</h1>
          <p className="text-sm text-muted-foreground">
            You set every price and limit here. Billing provider: <strong>{provider === "stripe" ? "Stripe" : "Mock (test mode)"}</strong>.
          </p>
        </div>
        <div className="flex gap-2">
          {needsSync ? <SyncPlansButton /> : null}
          <Button asChild><Link href="/admin/plans/new">New plan</Link></Button>
        </div>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{plans.length} plans</CardTitle>
          <CardDescription>Limit and feature changes take effect immediately. Price changes apply to new subscribers; existing ones are grandfathered.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table data-testid="admin-plans">
            <TableHeader>
              <TableRow>
                <TableHead>Plan</TableHead><TableHead>Price</TableHead><TableHead>Posts</TableHead><TableHead>Credits</TableHead>
                <TableHead>Accounts</TableHead><TableHead>Members</TableHead><TableHead>Paying</TableHead><TableHead>Comped</TableHead><TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {plans.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <span className="font-medium">{p.name}</span> <span className="text-xs text-muted-foreground">{p.key}</span>{" "}
                    {!p.isActive ? <Badge variant="destructive">inactive</Badge> : null} {!p.isPublic ? <Badge variant="secondary">hidden</Badge> : null}
                  </TableCell>
                  <TableCell className="tabular-nums" data-testid={`price-${p.key}`}>
                    {p.priceCents === 0 ? "Free" : `${formatMoney(p.priceCents, p.currency)}/${intervalLabel(p.interval)}`}
                    {p.prices.length > 1 ? <span className="ml-1 text-xs text-muted-foreground">({p.prices.length - 1} older)</span> : null}
                  </TableCell>
                  <TableCell>{formatLimit(p.maxPostsPerMonth)}</TableCell>
                  <TableCell>{formatLimit(p.monthlyCredits)}</TableCell>
                  <TableCell>{formatLimit(p.maxSocialAccounts)}</TableCell>
                  <TableCell>{formatLimit(p.maxMembers)}</TableCell>
                  <TableCell className="tabular-nums">{p.paidSubscribers}</TableCell>
                  <TableCell className="tabular-nums">{p.compedWorkspaces}</TableCell>
                  <TableCell className="text-right"><Button asChild variant="outline" size="sm"><Link href={`/admin/plans/${p.id}`}>Edit</Link></Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
