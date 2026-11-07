import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pagination, qs } from "@/components/app/pagination";
import { queryAudit } from "@/server/admin/management";
import { requireSuperAdmin } from "@/server/tenancy/context";

export const metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

type SP = { action?: string; actor?: string; workspaceId?: string; from?: string; to?: string; impersonated?: string; page?: string };

export default async function AuditPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireSuperAdmin();
  const sp = await searchParams;
  const r = await queryAudit({ ...sp, impersonatedOnly: sp.impersonated === "1" });
  const { page: _p, ...filters } = sp;
  void _p;
  return (
    <div className="grid grid-cols-1 gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Audit log <span className="text-base font-normal text-muted-foreground">({r.total})</span></h1>
      <form className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end" role="search" data-testid="audit-filters">
        <div className="grid gap-1"><Label htmlFor="f-action">Action</Label><Input id="f-action" name="action" defaultValue={sp.action} placeholder="e.g. admin.workspace" /></div>
        <div className="grid gap-1"><Label htmlFor="f-actor">Actor email</Label><Input id="f-actor" name="actor" defaultValue={sp.actor} /></div>
        <div className="grid gap-1"><Label htmlFor="f-ws">Workspace ID</Label><Input id="f-ws" name="workspaceId" defaultValue={sp.workspaceId} /></div>
        <div className="grid gap-1"><Label htmlFor="f-from">From</Label><Input id="f-from" type="date" name="from" defaultValue={sp.from} /></div>
        <div className="grid gap-1"><Label htmlFor="f-to">To</Label><Input id="f-to" type="date" name="to" defaultValue={sp.to} /></div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="impersonated" value="1" defaultChecked={sp.impersonated === "1"} /> Support only</label>
          <Button type="submit" variant="outline">Filter</Button>
        </div>
      </form>
      <Card>
        <CardContent className="pt-6">
          <Table data-testid="audit-table">
            <TableHeader><TableRow><TableHead>When (UTC)</TableHead><TableHead>Action</TableHead><TableHead>Actor</TableHead><TableHead>Workspace</TableHead><TableHead>Target</TableHead><TableHead>Details</TableHead></TableRow></TableHeader>
            <TableBody>
              {r.rows.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-xs">{e.createdAt.toISOString().slice(0, 19).replace("T", " ")}</TableCell>
                  <TableCell className="font-mono text-xs">{e.action}</TableCell>
                  <TableCell className="text-xs">
                    {e.actor?.email ?? "system"}
                    {e.impersonator ? <Badge variant="outline" className="ml-1" title={`Done by ${e.impersonator.email} in support mode`}>via {e.impersonator.email}</Badge> : null}
                  </TableCell>
                  <TableCell className="text-xs">{e.workspace ? <Link className="underline-offset-4 hover:underline" href={`/admin/workspaces/${e.workspace.id}`}>{e.workspace.name}</Link> : "—"}</TableCell>
                  <TableCell className="text-xs">{e.targetType ? `${e.targetType}${e.targetId ? ` ${e.targetId.slice(0, 10)}…` : ""}` : "—"}</TableCell>
                  <TableCell className="max-w-xs text-xs">
                    {e.metadata && Object.keys(e.metadata as object).length ? (
                      <details><summary className="cursor-pointer text-muted-foreground">view</summary><pre className="mt-1 whitespace-pre-wrap break-all">{JSON.stringify(e.metadata, null, 2)}</pre></details>
                    ) : "—"}
                  </TableCell>
                </TableRow>
              ))}
              {r.rows.length === 0 ? <TableRow><TableCell colSpan={6} className="text-center text-sm text-muted-foreground">No matching events.</TableCell></TableRow> : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Pagination page={r.page} pages={r.pages} href={(p) => `/admin/audit${qs({ ...filters, page: p })}`} />
    </div>
  );
}
