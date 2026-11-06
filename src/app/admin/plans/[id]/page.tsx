import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatMoney, intervalLabel } from "@/lib/format";
import { listPlansWithStats } from "@/server/billing/plans";
import { requireSuperAdmin } from "@/server/tenancy/context";
import { PlanForm } from "../plan-form";

export const metadata = { title: "Edit plan" };
export const dynamic = "force-dynamic";

export default async function EditPlanPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }> }) {
  await requireSuperAdmin();
  const { id } = await params;
  const { saved } = await searchParams;
  const plan = (await listPlansWithStats()).find((p) => p.id === id);
  if (!plan) notFound();

  return (
    <div className="grid gap-6">
      {saved === "created" ? <p role="status" className="rounded-md border p-3 text-sm">Plan created.</p> : null}
      <Card>
        <CardHeader>
          <CardTitle>Edit {plan.name}</CardTitle>
          <CardDescription>{plan.paidSubscribers} paying · {plan.compedWorkspaces} comped</CardDescription>
        </CardHeader>
        <CardContent>
          <PlanForm subscriberCount={plan.paidSubscribers} plan={{ ...plan, description: plan.description ?? "", features: plan.features }} />
        </CardContent>
      </Card>
      {plan.prices.length ? (
        <Card>
          <CardHeader><CardTitle>Price history</CardTitle><CardDescription>Subscribers stay on the price they signed up with until they change plan.</CardDescription></CardHeader>
          <CardContent>
            <Table data-testid="price-history">
              <TableHeader><TableRow><TableHead>Price</TableHead><TableHead>Provider id</TableHead><TableHead>Created</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {plan.prices.map((pr) => (
                  <TableRow key={pr.id}>
                    <TableCell className="tabular-nums">{formatMoney(pr.priceCents, pr.currency)}/{intervalLabel(pr.interval)}</TableCell>
                    <TableCell className="font-mono text-xs">{pr.providerPriceId}</TableCell>
                    <TableCell>{formatDate(pr.createdAt)}</TableCell>
                    <TableCell>{pr.isCurrent ? <Badge>current</Badge> : <Badge variant="outline">grandfathered</Badge>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
