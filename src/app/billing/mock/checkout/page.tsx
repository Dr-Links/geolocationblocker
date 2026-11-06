import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CenteredShell } from "@/components/app/centered-shell";
import { formatMoney, intervalLabel } from "@/lib/format";
import { loadMockCheckout } from "@/server/billing/checkout";
import { AppError } from "@/server/errors";
import { requireUser } from "@/server/tenancy/context";
import { MockPayForm } from "./pay-form";

export const metadata = { title: "Checkout (test mode)" };
export const dynamic = "force-dynamic";

/** Stand-in for Stripe Checkout when Stripe isn't configured. */
export default async function MockCheckoutPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const user = await requireUser();
  const { t = "" } = await searchParams;
  let data;
  try {
    data = await loadMockCheckout(t, user.id);
  } catch (err) {
    return (
      <CenteredShell>
        <Card><CardHeader><CardTitle>Checkout unavailable</CardTitle><CardDescription>{err instanceof AppError ? err.message : "Something went wrong."}</CardDescription></CardHeader>
          <CardContent><Link href="/dashboard/billing" className="underline underline-offset-4">Back to billing</Link></CardContent></Card>
      </CenteredShell>
    );
  }
  const amount = `${formatMoney(data.price.priceCents, data.price.currency)}/${intervalLabel(data.price.interval)}`;
  return (
    <CenteredShell>
      <Card>
        <CardHeader>
          <p className="w-fit rounded bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">TEST MODE · no real charge</p>
          <CardTitle className="text-2xl">Subscribe to {data.price.plan.name}</CardTitle>
          <CardDescription>{data.workspaceName} · {amount}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <MockPayForm token={t} amount={amount} />
          <Link href="/dashboard/billing?checkout=cancel" className="text-center text-sm text-muted-foreground underline underline-offset-4">Cancel</Link>
        </CardContent>
      </Card>
    </CenteredShell>
  );
}
