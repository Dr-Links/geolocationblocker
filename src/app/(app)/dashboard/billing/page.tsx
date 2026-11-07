import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { UsageMeters } from "@/components/billing/usage-meters";
import { withTenantTx } from "@/lib/db";
import { formatDate, formatMoney, intervalLabel } from "@/lib/format";
import { listPurchasablePlans } from "@/server/billing/checkout";
import { getEntitlements, getUsage } from "@/server/billing/entitlements";
import { FEATURE_KEYS, FEATURE_LABELS, hasPaidAccess, limitPhrase, parseFeatures } from "@/server/billing/limits";
import { getBillingProvider } from "@/server/billing/providers";
import { can } from "@/server/tenancy/permissions";
import { getTenantContext } from "@/server/tenancy/context";
import { ChoosePlanButton, ManageBillingButton } from "./billing-buttons";

export const metadata = { title: "Billing" };

const STATUS_TEXT: Record<string, string> = {
  ACTIVE: "Active", TRIALING: "Trial", PAST_DUE: "Payment failed: update your card", CANCELED: "Canceled", UNPAID: "Unpaid", INCOMPLETE: "Incomplete",
};

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ checkout?: string }> }) {
  const { checkout } = await searchParams;
  const ctx = await getTenantContext();
  // Support staff impersonating a workspace can see but not change billing or AI keys.
  const canManage = can(ctx.role, "billing.manage") && !ctx.impersonatorId;
  const { ent, usage } = await withTenantTx(ctx.workspaceId, async (tx) => {
    const ent = await getEntitlements(tx, ctx.workspaceId);
    return { ent, usage: await getUsage(tx, ctx.workspaceId, ent) };
  });
  const plans = await listPurchasablePlans();
  const sub = ent.subscription;
  const paid = sub ? hasPaidAccess(sub) : false;
  const mock = getBillingProvider().name === "mock";

  return (
    <div className="grid grid-cols-1 gap-6">
      <div>
        {ctx.impersonatorId ? <p className="mb-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm" data-testid="impersonation-readonly">Read-only in support mode.</p> : null}
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        {mock ? <p className="text-sm text-muted-foreground">Test mode: payments are simulated (Stripe isn&apos;t connected yet).</p> : null}
      </div>

      {checkout === "success" ? <p role="status" className="rounded-md border border-green-600/30 bg-green-600/10 p-3 text-sm">Payment received. Your plan is active.</p> : null}
      {checkout === "cancel" ? <p role="status" className="rounded-md border p-3 text-sm text-muted-foreground">Checkout canceled. You weren&apos;t charged.</p> : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span data-testid="current-plan">{ent.plan.name}</span>
            {ent.source === "comp" ? <Badge variant="secondary">Complimentary</Badge> : null}
            {ent.source === "paid" && sub ? <Badge variant={sub.status === "PAST_DUE" ? "destructive" : "outline"} data-testid="sub-status">{STATUS_TEXT[sub.status]}</Badge> : null}
            {ent.source === "lapsed" ? <Badge variant="destructive">Subscription ended</Badge> : null}
          </CardTitle>
          <CardDescription>
            {ent.source === "comp"
              ? `Provided free by the platform${sub?.compExpiresAt ? ` until ${formatDate(sub.compExpiresAt)}` : ""}.`
              : paid && sub
                ? `${formatMoney(sub.priceCents ?? 0)}/${intervalLabel(sub.billingInterval)} · ${sub.cancelAtPeriodEnd ? "ends" : "renews"} ${formatDate(sub.currentPeriodEnd)}`
                : "Free plan."}
            {` Usage period: ${formatDate(ent.period.start)} to ${formatDate(ent.period.end)}.`}
          </CardDescription>
        </CardHeader>
        <CardContent><UsageMeters ent={ent} usage={usage} /></CardContent>
        {canManage && paid ? <CardFooter><ManageBillingButton /></CardFooter> : null}
      </Card>

      {!canManage ? (
        <p className="text-sm text-muted-foreground">{ctx.impersonatorId ? "Plan changes are disabled in support mode." : "Only workspace admins can change the plan."}</p>
      ) : ent.source === "comp" ? null : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {plans.map((p) => {
            const features = parseFeatures(p.features);
            const isCurrent = ent.plan.id === p.id && (paid || p.priceCents === 0);
            return (
              <Card key={p.id} className={`flex flex-col ${isCurrent ? "border-primary" : ""}`} data-testid={`plan-card-${p.key}`}>
                <CardHeader>
                  <CardTitle>{p.name}</CardTitle>
                  <CardDescription>{p.description}</CardDescription>
                  <p className="pt-2 text-3xl font-semibold tabular-nums">
                    {p.priceCents === 0 ? "Free" : formatMoney(p.priceCents, p.currency)}
                    {p.priceCents > 0 ? <span className="text-sm font-normal text-muted-foreground">/{intervalLabel(p.interval)}</span> : null}
                  </p>
                </CardHeader>
                <CardContent className="grid flex-1 content-start gap-1.5 text-sm">
                  {(["maxPostsPerMonth", "monthlyCredits", "maxSocialAccounts", "maxMembers"] as const).map((k) => (
                    <span key={k}>{p[k] < 0 ? `Unlimited ${limitPhrase(k, 2).replace(/^\d+ /, "")}` : limitPhrase(k, p[k])}</span>
                  ))}
                  {FEATURE_KEYS.filter((k) => features[k]).map((k) => (
                    <span key={k} className="flex items-center gap-1.5"><Check className="size-4" /> {FEATURE_LABELS[k]}</span>
                  ))}
                </CardContent>
                <CardFooter>
                  {isCurrent ? (
                    <Badge variant="outline">Current plan</Badge>
                  ) : p.priceCents === 0 ? (
                    paid ? <span className="text-xs text-muted-foreground">Cancel your subscription in Manage billing to return to Free.</span> : null
                  ) : (
                    <div className="w-full"><ChoosePlanButton planId={p.id} label={paid ? `Switch to ${p.name}` : `Choose ${p.name}`} /></div>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
