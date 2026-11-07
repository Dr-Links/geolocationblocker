import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pagination, qs } from "@/components/app/pagination";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { listUsers } from "@/server/admin/management";
import { requireSuperAdmin } from "@/server/tenancy/context";

export const metadata = { title: "Users" };
export const dynamic = "force-dynamic";

const FILTERS = [["all", "All"], ["admins", "Super admins"], ["disabled", "Disabled"]] as const;

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<{ q?: string; filter?: string; page?: string }> }) {
  await requireSuperAdmin();
  const sp = await searchParams;
  const filter = FILTERS.find(([f]) => f === sp.filter)?.[0] ?? "all";
  const r = await listUsers({ q: sp.q, filter, page: sp.page });
  return (
    <div className="grid grid-cols-1 gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Users <span className="text-base font-normal text-muted-foreground">({r.total})</span></h1>
      <form className="flex flex-wrap gap-2" role="search">
        <Input name="q" defaultValue={sp.q} placeholder="Search email or name" className="max-w-sm" aria-label="Search users" />
        <input type="hidden" name="filter" value={filter} />
        <Button type="submit" variant="outline">Search</Button>
      </form>
      <nav className="flex flex-wrap gap-1" aria-label="Filter">
        {FILTERS.map(([f, label]) => (
          <Link key={f} href={`/admin/users${qs({ q: sp.q, filter: f === "all" ? undefined : f })}`}
            className={cn("rounded-md px-3 py-1.5 text-sm", filter === f ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{label}</Link>
        ))}
      </nav>
      <Card>
        <CardContent className="pt-6">
          <Table data-testid="admin-users">
            <TableHeader><TableRow><TableHead>Email</TableHead><TableHead>Name</TableHead><TableHead>Role</TableHead><TableHead>Workspaces</TableHead><TableHead>Joined</TableHead><TableHead>Last login</TableHead></TableRow></TableHeader>
            <TableBody>
              {r.rows.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>
                    <Link href={`/admin/users/${u.id}`} className="underline-offset-4 hover:underline">{u.email}</Link>
                    {u.disabledAt ? <Badge variant="destructive" className="ml-2">disabled</Badge> : null}
                  </TableCell>
                  <TableCell>{u.name ?? "—"}</TableCell>
                  <TableCell>{u.platformRole === "SUPER_ADMIN" ? <Badge>SUPER_ADMIN</Badge> : "User"}</TableCell>
                  <TableCell className="tabular-nums">{u._count.memberships}</TableCell>
                  <TableCell>{formatDate(u.createdAt)}</TableCell>
                  <TableCell>{u.lastLoginAt?.toISOString().slice(0, 16).replace("T", " ") ?? "never"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Pagination page={r.page} pages={r.pages} href={(p) => `/admin/users${qs({ q: sp.q, filter: filter === "all" ? undefined : filter, page: p })}`} />
    </div>
  );
}
