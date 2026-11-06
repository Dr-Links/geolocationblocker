import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { systemDb } from "@/lib/db";
import { requireSuperAdmin } from "@/server/tenancy/context";
import { CreateCompedAccountForm } from "./create-form";

export const metadata = { title: "Create free account" };

export default async function NewCompedAccountPage() {
  await requireSuperAdmin();
  const plans = await systemDb.plan.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" }, select: { id: true, name: true } });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Create a free (comped) account</CardTitle>
        <CardDescription>Creates a workspace with a complimentary plan. New owners get an admin invitation link; existing users are added right away.</CardDescription>
      </CardHeader>
      <CardContent><CreateCompedAccountForm plans={plans} /></CardContent>
    </Card>
  );
}
