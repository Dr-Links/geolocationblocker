import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listMembers, listPendingInvitations } from "@/server/services/members";
import { can } from "@/server/tenancy/permissions";
import { requireTenant } from "@/server/tenancy/context";
import { InviteForm, RemoveMemberButton, RevokeInviteButton, RoleSelect } from "./member-controls";

export const metadata = { title: "Members" };

const roleLabel = (r: string) => (r === "WORKSPACE_ADMIN" ? "Admin" : "Member");

export default async function MembersPage() {
  const ctx = await requireTenant("members.view");
  const canManage = can(ctx.role, "members.manage");
  const [members, invites] = await Promise.all([listMembers(ctx), canManage ? listPendingInvitations(ctx) : Promise.resolve([])]);

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Members</h1>

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Invite a teammate</CardTitle>
            <CardDescription>Admins manage members, billing and connected accounts. Members create and schedule content.</CardDescription>
          </CardHeader>
          <CardContent><InviteForm /></CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>{members.length} member{members.length === 1 ? "" : "s"}</CardTitle></CardHeader>
        <CardContent>
          <Table data-testid="members-table">
            <TableHeader>
              <TableRow><TableHead>Name</TableHead><TableHead>Email</TableHead><TableHead>Role</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => {
                const isSelf = m.userId === ctx.userId;
                return (
                  <TableRow key={m.id}>
                    <TableCell>{m.user.name ?? "—"} {isSelf ? <Badge variant="secondary">you</Badge> : null}</TableCell>
                    <TableCell>{m.user.email}</TableCell>
                    <TableCell>{canManage ? <RoleSelect membershipId={m.id} role={m.role} /> : roleLabel(m.role)}</TableCell>
                    <TableCell className="text-right">
                      {canManage || isSelf ? <RemoveMemberButton membershipId={m.id} isSelf={isSelf} /> : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {canManage && invites.length > 0 ? (
        <Card>
          <CardHeader><CardTitle>Pending invitations</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow><TableHead>Email</TableHead><TableHead>Role</TableHead><TableHead>Expires</TableHead><TableHead /></TableRow>
              </TableHeader>
              <TableBody>
                {invites.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>{i.email}</TableCell>
                    <TableCell>{roleLabel(i.role)}</TableCell>
                    <TableCell>{i.expiresAt.toISOString().slice(0, 10)}</TableCell>
                    <TableCell className="text-right"><RevokeInviteButton invitationId={i.id} /></TableCell>
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
