import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getTenantContext } from "@/server/tenancy/context";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const ctx = await getTenantContext();
  const { db, workspaceId, user } = ctx;

  const [workspace, drafts, scheduled, published, accounts] = await Promise.all([
    db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, include: { subscription: { include: { plan: true } } } }),
    db.post.count({ where: { workspaceId, status: "DRAFT" } }),
    db.post.count({ where: { workspaceId, status: "SCHEDULED" } }),
    db.post.count({ where: { workspaceId, status: "PUBLISHED" } }),
    db.socialAccount.count({ where: { workspaceId, status: "CONNECTED" } }),
  ]);

  const stats = [
    { label: "Drafts", value: drafts },
    { label: "Scheduled", value: scheduled },
    { label: "Published", value: published },
    { label: "Connected accounts", value: accounts },
  ];
  const isEmpty = stats.every((s) => s.value === 0);
  const plan = workspace.subscription?.plan;

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome{user.name ? `, ${user.name}` : ""}</h1>
        <p className="text-sm text-muted-foreground">
          {workspace.name}
          {plan ? ` · ${plan.name} plan` : ""}
          {workspace.subscription?.isComped ? " (comped)" : ""}
          {` · you are ${ctx.role === "WORKSPACE_ADMIN" ? "an admin" : "a member"}`}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-2">
              <CardDescription>{s.label}</CardDescription>
              <CardTitle className="text-3xl tabular-nums" data-testid={`stat-${s.label.toLowerCase().replace(/\s+/g, "-")}`}>{s.value}</CardTitle>
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
