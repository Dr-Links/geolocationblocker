import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { UsageMeters } from "@/components/billing/usage-meters";
import { systemDb, withSystemTx } from "@/lib/db";
import { formatDate, formatMoney, intervalLabel } from "@/lib/format";
import { getWorkspaceBillingForAdmin } from "@/server/billing/comp";
import { getEntitlements, getUsage } from "@/server/billing/entitlements";
import { hasPaidAccess, isCompActive } from "@/server/billing/limits";
import { NotFoundError } from "@/server/errors";
import { requireSuperAdmin } from "@/server/tenancy/context";
import { CompForm, RemoveCompForm } from "./comp-forms";
import { ImpersonateForm, SuspendForm } from "./support-forms";
import { PLATFORM_RULES } from "@/lib/platforms";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Workspace" };
export const dynamic = "force-dynamic";

export default async function AdminWorkspacePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  await requireSuperAdmin();
  const { id } = await params;
  const { notice } = await searchParams;
  const ws = await getWorkspaceBillingForAdmin(id).catch((e) => (e instanceof NotFoundError ? null : Promise.reject(e)));
  if (!ws) notFound();
  const { ent, usage } = await withSystemTx(async (tx) => {
    const ent = await getEntitlements(tx, id);
    return { ent, usage: await getUsage(tx, id, ent) };
  });
  const [accounts, posts, audit] = await Promise.all([
    systemDb.socialAccount.findMany({ where: { workspaceId: id }, orderBy: { createdAt: "asc" } }),
    systemDb.post.findMany({ where: { workspaceId: id }, orderBy: { updatedAt: "desc" }, take: 10, include: { targets: { select: { status: true } }, schedule: true } }),
    systemDb.auditLog.findMany({ where: { workspaceId: id }, orderBy: { createdAt: "desc" }, take: 15, include: { actor: { select: { email: true } }, impersonator: { select: { email: true } } } }),
  ]);
  const plans = await systemDb.plan.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" }, select: { id: true, name: true } });
  const sub = ws.subscription;
  const comped = sub ? isCompActive(sub, new Date()) : false;
  const paid = sub ? hasPaidAccess(sub) : false;

  return (
    <div className="grid grid-cols-1 gap-6">
      {notice === "uncomped" ? <p role="status" className="rounded-md border p-3 text-sm">Comp removed. The workspace is back on its billed plan.</p> : null}
      {notice === "suspended" ? <p role="status" className="rounded-md border border-destructive/40 p-3 text-sm">Workspace suspended. Members are locked out and scheduled posts won&apos;t publish.</p> : null}
      {notice === "unsuspended" ? <p role="status" className="rounded-md border p-3 text-sm">Workspace reinstated.</p> : null}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ws.name}</h1>
        <p className="text-sm text-muted-foreground">{ws.slug} · created {formatDate(ws.createdAt)} · {ws._count.posts} posts · {ws._count.socialAccounts} accounts</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Entitlements: <span data-testid="effective-plan">{ent.plan.name}</span>
            <Badge variant={comped ? "secondary" : "outline"} data-testid="entitlement-source">{ent.source}</Badge>
          </CardTitle>
          <CardDescription>
            Billed plan: {sub?.plan.name ?? "Free"}
            {paid && sub ? ` · ${formatMoney(sub.priceCents ?? 0)}/${intervalLabel(sub.billingInterval)} · ${sub.status}${sub.cancelAtPeriodEnd ? " (cancels at period end)" : ""}` : ""}
            {comped && sub ? ` · Comped onto ${sub.compPlan?.name ?? sub.plan.name} by ${sub.compedBy?.email ?? "admin"} on ${formatDate(sub.compedAt)}: "${sub.compReason}"${sub.compExpiresAt ? `, expires ${formatDate(sub.compExpiresAt)}` : ""}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent><UsageMeters ent={ent} usage={usage} /></CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{comped ? "Change comp" : "Comp this workspace"}</CardTitle>
          <CardDescription>Grant a plan for free, in full or with custom limits. Stripe changes never override a comp.</CardDescription>
        </CardHeader>
        <CardContent><CompForm workspaceId={ws.id} plans={plans} hasPaid={paid} /></CardContent>
      </Card>

      {comped ? (
        <Card>
          <CardHeader><CardTitle>Remove comp</CardTitle><CardDescription>The workspace goes back to its billed plan ({paid ? sub?.plan.name : "Free"}).</CardDescription></CardHeader>
          <CardContent><RemoveCompForm workspaceId={ws.id} /></CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Support access</CardTitle><CardDescription>Act inside this workspace as its admin for 60 minutes. Everything you do is audited; billing and API keys stay locked.</CardDescription></CardHeader>
          <CardContent><ImpersonateForm workspaceId={ws.id} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">Suspension {ws.suspendedAt ? <Badge variant="destructive" data-testid="suspended-badge">suspended {formatDate(ws.suspendedAt)}</Badge> : null}</CardTitle>
            <CardDescription>Suspended workspaces can&apos;t be used by their members and don&apos;t publish.</CardDescription>
          </CardHeader>
          <CardContent><SuspendForm workspaceId={ws.id} suspended={!!ws.suspendedAt} /></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Connected accounts</CardTitle></CardHeader>
        <CardContent className="grid gap-1 text-sm">
          {accounts.length === 0 ? <span className="text-muted-foreground">None.</span> : null}
          {accounts.map((a) => (
            <span key={a.id}>{PLATFORM_RULES[a.platform].label} · {a.handle ?? a.displayName} · <Badge variant={a.status === "CONNECTED" ? "outline" : "destructive"}>{a.status.toLowerCase()}</Badge>{a.isMock ? " (mock)" : ""}{a.lastError ? <span className="text-xs text-destructive"> {a.lastError}</span> : null}</span>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Recent posts</CardTitle></CardHeader>
        <CardContent className="grid gap-1 text-sm">
          {posts.length === 0 ? <span className="text-muted-foreground">None.</span> : null}
          {posts.map((p) => (
            <span key={p.id} className="flex min-w-0 gap-2">
              <Badge variant={p.status === "FAILED" || p.status === "PARTIALLY_PUBLISHED" ? "destructive" : "outline"}>{p.status.replace("_", " ").toLowerCase()}</Badge>
              <span className="min-w-0 truncate">{p.content || "(media only)"}</span>
            </span>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Audit trail</CardTitle><CardDescription><a className="underline" href={`/admin/audit?workspaceId=${ws.id}`}>See all</a></CardDescription></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Action</TableHead><TableHead>By</TableHead></TableRow></TableHeader>
            <TableBody>
              {audit.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-xs">{e.createdAt.toISOString().slice(0, 16).replace("T", " ")}</TableCell>
                  <TableCell className="font-mono text-xs">{e.action}</TableCell>
                  <TableCell className="text-xs">{e.actor?.email ?? "system"}{e.impersonator ? <Badge variant="secondary" className="ml-1">support</Badge> : null}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Members</CardTitle></CardHeader>
        <CardContent className="grid gap-1 text-sm">
          {ws.memberships.length === 0 ? <span className="text-muted-foreground">No members yet (owner invitation pending).</span> : null}
          {ws.memberships.map((m) => <span key={m.id}>{m.user.email} · {m.role === "WORKSPACE_ADMIN" ? "Admin" : "Member"}</span>)}
        </CardContent>
      </Card>
    </div>
  );
}
