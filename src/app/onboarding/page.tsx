import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CenteredShell } from "@/components/app/centered-shell";
import { CreateWorkspaceForm } from "@/components/app/create-workspace-form";
import { listMyWorkspaces, requireUser } from "@/server/tenancy/context";

export const metadata = { title: "Create your workspace" };

/** First stop for users with no workspace (e.g. OAuth sign-ups, or after leaving their last one). */
export default async function OnboardingPage() {
  const user = await requireUser();
  if ((await listMyWorkspaces(user.id)).length > 0) redirect("/dashboard");
  return (
    <CenteredShell>
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Create your workspace</CardTitle>
          <CardDescription>A workspace holds your social accounts, content and billing. You can invite teammates later.</CardDescription>
        </CardHeader>
        <CardContent><CreateWorkspaceForm /></CardContent>
      </Card>
    </CenteredShell>
  );
}
