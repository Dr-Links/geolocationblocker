import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSuperAdmin } from "@/server/tenancy/context";
import { PlanForm } from "../plan-form";

export const metadata = { title: "New plan" };

export default async function NewPlanPage() {
  await requireSuperAdmin();
  return (
    <Card>
      <CardHeader><CardTitle>New plan</CardTitle></CardHeader>
      <CardContent>
        <PlanForm plan={{ key: "", name: "", description: "", priceCents: 0, currency: "usd", interval: "MONTH", maxPostsPerMonth: 100,
          monthlyCredits: 100, maxSocialAccounts: 5, maxMembers: 2, features: { video: false, byok: false, recurring: false }, isActive: true, isPublic: true, sortOrder: 10 }} />
      </CardContent>
    </Card>
  );
}
