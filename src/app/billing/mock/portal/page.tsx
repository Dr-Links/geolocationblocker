import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CenteredShell } from "@/components/app/centered-shell";
import { formatDate, formatMoney, intervalLabel } from "@/lib/format";
import { loadMockPortal } from "@/server/billing/checkout";
import { AppError } from "@/server/errors";
import { requireUser } from "@/server/tenancy/context";
import { PortalButton } from "./portal-controls";

export const metadata = { title: "Billing portal (test mode)" };
export const dynamic = "force-dynamic";

/** Stand-in for the Stripe customer portal, plus lifecycle simulations for testing. */
export default async function MockPortalPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const user = await requireUser();
  const { t = "" } = await searchParams;
  let data;
  try {
    data = await loadMockPortal(t, user.id);
  } catch (err) {
    return (
      <CenteredShell>
        <Card><CardHeader><CardTitle>Portal unavailable</CardTitle><CardDescription>{err instanceof AppError ? err.message : "Something went wrong."}</CardDescription></CardHeader>
          <CardContent><Link href="/dashboard/billing" className="underline underline-offset-4">Back to billing</Link></CardContent></Card>
      </CenteredShell>
    );
  }
  const { sub, plans } = data;
  const active = sub.status !== "CANCELED";
  return (
    <CenteredShell>
      <Card>
        <CardHeader>
          <p className="w-fit rounded bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">TEST MODE · mock billing portal</p>
          <CardTitle className="flex items-center gap-2 text-2xl">{sub.plan.name} <Badge variant="outline" data-testid="portal-status">{sub.status}</Badge></CardTitle>
          <CardDescription>
            {formatMoney(sub.priceCents ?? 0)}/{intervalLabel(sub.billingInterval)} · {sub.cancelAtPeriodEnd ? "ends" : "renews"} {formatDate(sub.currentPeriodEnd)}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          {active ? (
            <>
              <div className="grid gap-2">
                <p className="text-sm font-medium">Change plan</p>
                <div className="flex flex-wrap gap-2">
                  {plans.filter((p) => p.id !== sub.planId).map((p) => (
                    <PortalButton key={p.id} token={t} kind="switch" planId={p.id} label={`${p.name} · ${formatMoney(p.priceCents, p.currency)}/${intervalLabel(p.interval)}`} />
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {sub.cancelAtPeriodEnd ? <PortalButton token={t} kind="resume" label="Resume subscription" variant="default" /> : <PortalButton token={t} kind="cancel_at_period_end" label="Cancel at period end" />}
                <PortalButton token={t} kind="cancel_now" label="Cancel immediately" variant="destructive" />
              </div>
              <div className="grid gap-2 rounded-md border border-dashed p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Simulate (testing only)</p>
                <div className="flex flex-wrap gap-2">
                  <PortalButton token={t} kind="simulate_renewal" label="Advance to next period" variant="ghost" />
                  <PortalButton token={t} kind="simulate_payment_failed" label="Fail next payment" variant="ghost" />
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">This subscription has ended.</p>
          )}
          <Link href="/dashboard/billing" className="text-sm underline underline-offset-4">Return to Postpilot</Link>
        </CardContent>
      </Card>
    </CenteredShell>
  );
}
