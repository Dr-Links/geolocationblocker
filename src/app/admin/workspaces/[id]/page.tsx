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
  const plans = await systemDb.plan.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" }, select: { id: true, name: true } });
  const sub = ws.subscription;
  const comped = sub ? isCompActive(sub, new Date()) : false;
  const paid = sub ? hasPaidAccess(sub) : false;

  return (
    <div className="grid grid-cols-1 gap-6">
      {notice === "uncomped" ? <p role="status" className="rounded-md border p-3 text-sm">Comp removed. The workspace is back on its billed plan.</p> : null}
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
