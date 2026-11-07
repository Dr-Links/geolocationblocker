import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pagination, qs } from "@/components/app/pagination";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { listWorkspaces, type WorkspaceFilter } from "@/server/admin/management";
import { requireSuperAdmin } from "@/server/tenancy/context";

export const metadata = { title: "Workspaces" };
export const dynamic = "force-dynamic";

const FILTERS: [WorkspaceFilter, string][] = [["all", "All"], ["paying", "Paying"], ["comped", "Comped"], ["free", "Free"], ["suspended", "Suspended"]];

export default async function AdminWorkspacesPage({ searchParams }: { searchParams: Promise<{ q?: string; filter?: string; page?: string }> }) {
  await requireSuperAdmin();
  const sp = await searchParams;
  const filter = (FILTERS.find(([f]) => f === sp.filter)?.[0] ?? "all") as WorkspaceFilter;
  const r = await listWorkspaces({ q: sp.q, filter, page: sp.page });
  return (
    <div className="grid grid-cols-1 gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Workspaces <span className="text-base font-normal text-muted-foreground">({r.total})</span></h1>
      <form className="flex flex-wrap gap-2" role="search">
        <Input name="q" defaultValue={sp.q} placeholder="Search name, slug or member email" className="max-w-sm" aria-label="Search workspaces" />
        <input type="hidden" name="filter" value={filter} />
        <Button type="submit" variant="outline">Search</Button>
      </form>
      <nav className="flex flex-wrap gap-1" aria-label="Filter">
        {FILTERS.map(([f, label]) => (
          <Link key={f} href={`/admin/workspaces${qs({ q: sp.q, filter: f === "all" ? undefined : f })}`}
            className={cn("rounded-md px-3 py-1.5 text-sm", filter === f ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{label}</Link>
        ))}
      </nav>
      <Card>
        <CardContent className="pt-6">
          <Table data-testid="admin-workspaces">
            <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Plan</TableHead><TableHead>Members</TableHead><TableHead>Accounts</TableHead><TableHead>Posts</TableHead><TableHead>Created</TableHead></TableRow></TableHeader>
            <TableBody>
              {r.rows.map((w) => (
                <TableRow key={w.id}>
                  <TableCell>
                    <Link href={`/admin/workspaces/${w.id}`} className="font-medium underline-offset-4 hover:underline">{w.name}</Link>
                    <span className="ml-2 text-xs text-muted-foreground">{w.slug}</span>
                    {w.suspendedAt ? <Badge variant="destructive" className="ml-2">suspended</Badge> : null}
                  </TableCell>
                  <TableCell>{w.planLabel} <Badge variant={w.source === "paying" ? "outline" : "secondary"}>{w.source}</Badge></TableCell>
                  <TableCell className="tabular-nums">{w._count.memberships}</TableCell>
                  <TableCell className="tabular-nums">{w._count.socialAccounts}</TableCell>
                  <TableCell className="tabular-nums">{w._count.posts}</TableCell>
                  <TableCell>{formatDate(w.createdAt)}</TableCell>
                </TableRow>
              ))}
              {r.rows.length === 0 ? <TableRow><TableCell colSpan={6} className="text-muted-foreground">No workspaces match.</TableCell></TableRow> : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Pagination page={r.page} pages={r.pages} href={(p) => `/admin/workspaces${qs({ q: sp.q, filter: filter === "all" ? undefined : filter, page: p })}`} />
    </div>
  );
}
