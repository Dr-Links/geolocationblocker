import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActionForm } from "@/components/forms/action-form";
import { Field } from "@/components/forms/field";
import { systemDb } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { getUserForAdmin } from "@/server/admin/management";
import { NotFoundError } from "@/server/errors";
import { requireSuperAdmin } from "@/server/tenancy/context";
import { forceSignOutAction, platformRoleAction, userDisabledAction } from "../../actions";

export const metadata = { title: "User" };
export const dynamic = "force-dynamic";

export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireSuperAdmin();
  const { id } = await params;
  const u = await getUserForAdmin(id).catch((e) => (e instanceof NotFoundError ? null : Promise.reject(e)));
  if (!u) notFound();
  const audit = await systemDb.auditLog.findMany({ where: { OR: [{ actorId: id }, { targetId: id }] }, orderBy: { createdAt: "desc" }, take: 20, include: { workspace: { select: { name: true } } } });
  const self = me.id === u.id;

  return (
    <div className="grid grid-cols-1 gap-6">
      <div>
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
          {u.email}
          {u.platformRole === "SUPER_ADMIN" ? <Badge>SUPER_ADMIN</Badge> : null}
          {u.disabledAt ? <Badge variant="destructive" data-testid="user-disabled">disabled</Badge> : null}
        </h1>
        <p className="text-sm text-muted-foreground">
          {u.name ?? "No name"} · joined {formatDate(u.createdAt)} · last login {u.lastLoginAt?.toISOString().slice(0, 16).replace("T", " ") ?? "never"}
          {u.accounts.length ? ` · signs in with ${u.accounts.map((a) => a.provider).join(", ")}` : ""}
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle>Workspaces</CardTitle></CardHeader>
        <CardContent className="grid gap-1 text-sm">
          {u.memberships.length === 0 ? <span className="text-muted-foreground">None.</span> : null}
          {u.memberships.map((m) => (
            <span key={m.workspace.id}>
              <Link href={`/admin/workspaces/${m.workspace.id}`} className="underline-offset-4 hover:underline">{m.workspace.name}</Link> · {m.role === "WORKSPACE_ADMIN" ? "Admin" : "Member"}
              {m.workspace.suspendedAt ? <Badge variant="destructive" className="ml-2">suspended</Badge> : null}
            </span>
          ))}
        </CardContent>
      </Card>

      {self ? <p className="text-sm text-muted-foreground">This is your account; disabling it or removing your own admin role isn&apos;t allowed.</p> : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card>
            <CardHeader><CardTitle>{u.disabledAt ? "Re-enable account" : "Disable account"}</CardTitle><CardDescription>{u.disabledAt ? `Disabled ${formatDate(u.disabledAt)}.` : "Blocks sign-in and ends every session immediately."}</CardDescription></CardHeader>
            <CardContent>
              <ActionForm action={userDisabledAction} submitLabel={u.disabledAt ? "Enable" : "Disable"} variant={u.disabledAt ? "default" : "destructive"}>
                <input type="hidden" name="userId" value={u.id} />
                <input type="hidden" name="disable" value={u.disabledAt ? "false" : "true"} />
                {u.disabledAt ? null : <Field name="reason" id="disable-reason" label="Reason (optional)" />}
              </ActionForm>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Sign out everywhere</CardTitle><CardDescription>Revokes all sessions; they can sign in again.</CardDescription></CardHeader>
            <CardContent>
              <ActionForm action={forceSignOutAction} submitLabel="Force sign-out" variant="outline"><input type="hidden" name="userId" value={u.id} /></ActionForm>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Platform role</CardTitle><CardDescription>SUPER_ADMINs can manage the whole platform.</CardDescription></CardHeader>
            <CardContent>
              <ActionForm action={platformRoleAction} submitLabel={u.platformRole === "SUPER_ADMIN" ? "Remove SUPER_ADMIN" : "Make SUPER_ADMIN"} variant="outline">
                <input type="hidden" name="userId" value={u.id} />
                <input type="hidden" name="role" value={u.platformRole === "SUPER_ADMIN" ? "USER" : "SUPER_ADMIN"} />
              </ActionForm>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader><CardTitle>Recent activity</CardTitle><CardDescription><a className="underline" href={`/admin/audit?actor=${encodeURIComponent(u.email)}`}>See all</a></CardDescription></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Action</TableHead><TableHead>Workspace</TableHead></TableRow></TableHeader>
            <TableBody>
              {audit.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-xs">{e.createdAt.toISOString().slice(0, 16).replace("T", " ")}</TableCell>
                  <TableCell className="font-mono text-xs">{e.action}</TableCell>
                  <TableCell className="text-xs">{e.workspace?.name ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
