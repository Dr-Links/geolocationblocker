import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/lib/db";
import { requireUserContext } from "@/server/session/current";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const { user, workspace } = await requireUserContext();

  const [drafts, scheduled, published, accounts] = workspace
    ? await Promise.all([
        db.post.count({ where: { workspaceId: workspace.id, status: "DRAFT" } }),
        db.post.count({ where: { workspaceId: workspace.id, status: "SCHEDULED" } }),
        db.post.count({ where: { workspaceId: workspace.id, status: "PUBLISHED" } }),
        db.socialAccount.count({ where: { workspaceId: workspace.id, status: "CONNECTED" } }),
      ])
    : [0, 0, 0, 0];

  const stats = [
    { label: "Drafts", value: drafts },
    { label: "Scheduled", value: scheduled },
    { label: "Published", value: published },
    { label: "Connected accounts", value: accounts },
  ];
  const isEmpty = stats.every((s) => s.value === 0);
  const plan = workspace?.subscription?.plan;

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome{user.name ? `, ${user.name}` : ""}</h1>
        <p className="text-sm text-muted-foreground">
          {workspace?.name}
          {plan ? ` · ${plan.name} plan` : ""}
          {workspace?.subscription?.isComped ? " (comped)" : ""}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-2">
              <CardDescription>{s.label}</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{s.value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      {isEmpty ? (
        <Card data-testid="empty-state">
          <CardHeader>
            <CardTitle>Nothing here yet</CardTitle>
            <CardDescription>Your workspace is ready. Next you&apos;ll connect social accounts and write your first post.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Connecting accounts, the composer, and scheduling arrive in later build phases.
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
