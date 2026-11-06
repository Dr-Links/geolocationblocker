import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { systemDb } from "@/lib/db";
import { requireSuperAdmin } from "@/server/tenancy/context";

export const metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

/** Read-only platform overview. Management actions (comp, suspend, impersonate) arrive in Phases 2 and 6. */
export default async function AdminPage() {
  await requireSuperAdmin(); // defense in depth: never rely on the layout alone
  const [userCount, workspaceCount, workspaces, users] = await Promise.all([
    systemDb.user.count(),
    systemDb.workspace.count(),
    systemDb.workspace.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { subscription: { include: { plan: true } }, _count: { select: { memberships: true, posts: true } } },
    }),
    systemDb.user.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, email: true, name: true, platformRole: true, disabledAt: true, createdAt: true, lastLoginAt: true, _count: { select: { memberships: true } } },
    }),
  ]);

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Platform overview</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card><CardHeader><CardDescription>Users</CardDescription><CardTitle className="text-3xl tabular-nums">{userCount}</CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Workspaces</CardDescription><CardTitle className="text-3xl tabular-nums">{workspaceCount}</CardTitle></CardHeader></Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Workspaces</CardTitle><CardDescription>Most recent 50</CardDescription></CardHeader>
        <CardContent>
          <Table data-testid="admin-workspaces">
            <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Plan</TableHead><TableHead>Members</TableHead><TableHead>Posts</TableHead><TableHead>Created</TableHead></TableRow></TableHeader>
            <TableBody>
              {workspaces.map((w) => (
                <TableRow key={w.id}>
                  <TableCell>{w.name} {w.suspendedAt ? <Badge variant="destructive">suspended</Badge> : null}</TableCell>
                  <TableCell>{w.subscription?.plan.name ?? "—"} {w.subscription?.isComped ? <Badge variant="secondary">comped</Badge> : null}</TableCell>
                  <TableCell className="tabular-nums">{w._count.memberships}</TableCell>
                  <TableCell className="tabular-nums">{w._count.posts}</TableCell>
                  <TableCell>{w.createdAt.toISOString().slice(0, 10)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Users</CardTitle><CardDescription>Most recent 50</CardDescription></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>Email</TableHead><TableHead>Name</TableHead><TableHead>Role</TableHead><TableHead>Workspaces</TableHead><TableHead>Last login</TableHead></TableRow></TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>{u.email} {u.disabledAt ? <Badge variant="destructive">disabled</Badge> : null}</TableCell>
                  <TableCell>{u.name ?? "—"}</TableCell>
                  <TableCell>{u.platformRole === "SUPER_ADMIN" ? <Badge>SUPER_ADMIN</Badge> : "User"}</TableCell>
                  <TableCell className="tabular-nums">{u._count.memberships}</TableCell>
                  <TableCell>{u.lastLoginAt?.toISOString().slice(0, 16).replace("T", " ") ?? "never"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
