import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/format";
import { getRevenueSummary } from "@/server/billing/checkout";
import { isCompActive } from "@/server/billing/limits";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { systemDb } from "@/lib/db";
import { requireSuperAdmin } from "@/server/tenancy/context";

export const metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

/** Platform overview. Suspend/disable/impersonate arrive in Phase 6. */
export default async function AdminPage() {
  await requireSuperAdmin(); // defense in depth: never rely on the layout alone
  const [revenue, userCount, workspaceCount, workspaces, users] = await Promise.all([
    getRevenueSummary(),
    systemDb.user.count(),
    systemDb.workspace.count(),
    systemDb.workspace.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { subscription: { include: { plan: true, compPlan: true } }, _count: { select: { memberships: true, posts: true } } },
    }),
    systemDb.user.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, email: true, name: true, platformRole: true, disabledAt: true, createdAt: true, lastLoginAt: true, _count: { select: { memberships: true } } },
    }),
  ]);

  return (
    <div className="grid grid-cols-1 gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Platform overview</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card><CardHeader><CardDescription>Users</CardDescription><CardTitle className="text-3xl tabular-nums">{userCount}</CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Workspaces</CardDescription><CardTitle className="text-3xl tabular-nums">{workspaceCount}</CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>MRR</CardDescription><CardTitle className="text-3xl tabular-nums" data-testid="mrr">{formatMoney(revenue.mrrCents)}</CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Paying · comped · past due</CardDescription><CardTitle className="text-3xl tabular-nums">{revenue.payingCount} · {revenue.compedCount} · {revenue.pastDueCount}</CardTitle></CardHeader></Card>
      </div>
      {revenue.byPlan.length ? (
        <Card>
          <CardHeader><CardTitle>Revenue by plan</CardTitle><CardDescription>ARR {formatMoney(revenue.arrCents)}</CardDescription></CardHeader>
          <CardContent className="grid gap-1 text-sm">
            {revenue.byPlan.map((r) => <span key={r.name}>{r.name}: {r.paying} paying · {formatMoney(r.mrrCents)}/mo</span>)}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>Workspaces</CardTitle><CardDescription>Most recent 50</CardDescription></CardHeader>
        <CardContent>
          <Table data-testid="admin-workspaces">
            <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Plan</TableHead><TableHead>Members</TableHead><TableHead>Posts</TableHead><TableHead>Created</TableHead></TableRow></TableHeader>
            <TableBody>
              {workspaces.map((w) => (
                <TableRow key={w.id}>
                  <TableCell>
                    <Link href={`/admin/workspaces/${w.id}`} className="underline-offset-4 hover:underline">{w.name}</Link>{" "}
                    {w.suspendedAt ? <Badge variant="destructive">suspended</Badge> : null}
                  </TableCell>
                  <TableCell>
                    {w.subscription && isCompActive(w.subscription, new Date())
                      ? <>{w.subscription.compPlan?.name ?? w.subscription.plan.name} <Badge variant="secondary">comped</Badge></>
                      : w.subscription?.plan.name ?? "Free"}
                  </TableCell>
                  <TableCell className="tabular-nums">{w._count.memberships}</TableCell>
                  <TableCell className="tabular-nums">{w._count.posts}</TableCell>
                  <TableCell>{w.createdAt.toISOString().slice(0, 10)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Users</CardTitle><CardDescription>Most recent 50</CardDescription></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>Email</TableHead><TableHead>Name</TableHead><TableHead>Role</TableHead><TableHead>Workspaces</TableHead><TableHead>Last login</TableHead></TableRow></TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>{u.email} {u.disabledAt ? <Badge variant="destructive">disabled</Badge> : null}</TableCell>
                  <TableCell>{u.name ?? "—"}</TableCell>
                  <TableCell>{u.platformRole === "SUPER_ADMIN" ? <Badge>SUPER_ADMIN</Badge> : "User"}</TableCell>
                  <TableCell className="tabular-nums">{u._count.memberships}</TableCell>
                  <TableCell>{u.lastLoginAt?.toISOString().slice(0, 16).replace("T", " ") ?? "never"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
