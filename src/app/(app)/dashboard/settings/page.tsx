import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/server/tenancy/permissions";
import { requireTenant } from "@/server/tenancy/context";
import { GeneralForm } from "./general-form";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const ctx = await requireTenant("workspace.view");
  const ws = await ctx.db.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId } });
  const canEdit = can(ctx.role, "workspace.update");
  return (
    <div className="grid grid-cols-1 gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Workspace settings</h1>
        <p className="text-sm text-muted-foreground">
          <Link href="/dashboard/settings/members" className="underline underline-offset-4">Manage members</Link>
          {" · "}
          <Link href="/dashboard/settings/ai" className="underline underline-offset-4">AI settings</Link>
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>{canEdit ? "Name and default timezone for scheduling." : "Only workspace admins can change these."}</CardDescription>
        </CardHeader>
        <CardContent>
          <GeneralForm name={ws.name} timezone={ws.timezone} canEdit={canEdit} />
        </CardContent>
      </Card>
    </div>
  );
}
