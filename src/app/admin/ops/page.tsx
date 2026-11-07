import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Stat } from "@/components/charts/stat";
import { getOpsOverview } from "@/server/admin/ops";
import { requireSuperAdmin } from "@/server/tenancy/context";

export const metadata = { title: "Publishing ops" };
export const dynamic = "force-dynamic";

const ts = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

export default async function OpsPage() {
  await requireSuperAdmin();
  const o = await getOpsOverview(7);
  const statusCount = (s: string) => o.accountStatus.find((a) => a.status === s)?._count._all ?? 0;
  return (
    <div className="grid grid-cols-1 gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Publishing operations</h1>
        <p className="text-sm text-muted-foreground">Failures and worker health across all workspaces, last {o.days} days.</p>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Failed publishes" value={o.failedTargets.length} hint={`last ${o.days} days`} testId="ops-failed" />
        <Stat label="Stuck in publishing" value={o.stuckPublishing} hint="swept every minute" testId="ops-stuck" />
        <Stat label="Accounts needing reconnect" value={statusCount("EXPIRED") + statusCount("ERROR")} hint={`${statusCount("CONNECTED")} connected`} testId="ops-unhealthy" />
        <Stat label="Failed generations" value={o.failedGenerations} hint={`last ${o.days} days`} />
      </div>

      <Card>
        <CardHeader><CardTitle>Queues</CardTitle><CardDescription>BullMQ job counts. If a queue is unreachable, check Redis and the worker.</CardDescription></CardHeader>
        <CardContent>
          <Table data-testid="ops-queues">
            <TableHeader><TableRow><TableHead>Queue</TableHead><TableHead>Waiting</TableHead><TableHead>Delayed</TableHead><TableHead>Active</TableHead><TableHead>Failed</TableHead><TableHead>Completed</TableHead></TableRow></TableHeader>
            <TableBody>
              {o.queues.map((q) => (
                <TableRow key={q.name}>
                  <TableCell className="font-mono text-xs">{q.name}{q.ok ? null : <Badge variant="destructive" className="ml-2">unreachable</Badge>}</TableCell>
                  {[q.waiting, q.delayed, q.active, q.failed, q.completed].map((n, i) => <TableCell key={i} className="tabular-nums">{n}</TableCell>)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Failed publishes</CardTitle><CardDescription>Most recent 100. The error is what the platform (or the scheduler) reported.</CardDescription></CardHeader>
        <CardContent>
          {o.failedTargets.length === 0 ? <p className="text-sm text-muted-foreground">No failures. 🎉</p> : (
            <Table data-testid="ops-failed-targets">
              <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Workspace</TableHead><TableHead>Account</TableHead><TableHead>Attempts</TableHead><TableHead>Error</TableHead></TableRow></TableHeader>
              <TableBody>
                {o.failedTargets.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="whitespace-nowrap text-xs">{ts(t.updatedAt)}</TableCell>
                    <TableCell><Link className="underline-offset-4 hover:underline" href={`/admin/workspaces/${t.post.workspace.id}`}>{t.post.workspace.name}</Link></TableCell>
                    <TableCell className="text-xs">{t.socialAccount.platform} · {t.socialAccount.handle ?? t.socialAccount.displayName}{t.socialAccount.isMock ? " (mock)" : ""}</TableCell>
                    <TableCell className="tabular-nums">{t.attempts}</TableCell>
                    <TableCell className="max-w-md break-words text-xs">{t.lastError ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Accounts needing attention</CardTitle><CardDescription>Expired or erroring connections. The workspace has to reconnect them.</CardDescription></CardHeader>
        <CardContent>
          {o.unhealthyAccounts.length === 0 ? <p className="text-sm text-muted-foreground">All accounts healthy.</p> : (
            <Table data-testid="ops-unhealthy-accounts">
              <TableHeader><TableRow><TableHead>Workspace</TableHead><TableHead>Account</TableHead><TableHead>Status</TableHead><TableHead>Since</TableHead></TableRow></TableHeader>
              <TableBody>
                {o.unhealthyAccounts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell><Link className="underline-offset-4 hover:underline" href={`/admin/workspaces/${a.workspace.id}`}>{a.workspace.name}</Link></TableCell>
                    <TableCell className="text-xs">{a.platform} · {a.handle ?? a.displayName}</TableCell>
                    <TableCell><Badge variant="destructive">{a.status.toLowerCase()}</Badge></TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{ts(a.updatedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
