import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/forms/action-form";
import { withTenantTx } from "@/lib/db";
import { formatDate, formatLimit } from "@/lib/format";
import { PLATFORM_KEYS, PLATFORM_RULES } from "@/lib/platforms";
import { getEntitlements, getUsage } from "@/server/billing/entitlements";
import { listAccounts } from "@/server/social/accounts";
import { realPublisher } from "@/server/social/registry";
import { can } from "@/server/tenancy/permissions";
import { requireTenant } from "@/server/tenancy/context";
import { checkHealthAction, disconnectAction } from "./actions";

export const metadata = { title: "Connected accounts" };
export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; variant: "outline" | "secondary" | "destructive" }> = {
  CONNECTED: { label: "Connected", variant: "outline" },
  EXPIRED: { label: "Expired: reconnect", variant: "destructive" },
  ERROR: { label: "Error", variant: "destructive" },
  DISCONNECTED: { label: "Disconnected", variant: "secondary" },
};

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ connected?: string; skipped?: string; error?: string }> }) {
  const ctx = await requireTenant("workspace.view");
  const q = await searchParams;
  const canManage = can(ctx.role, "accounts.manage");
  const [accounts, { ent, usage }] = await Promise.all([
    listAccounts(ctx),
    withTenantTx(ctx.workspaceId, async (tx) => {
      const ent = await getEntitlements(tx, ctx.workspaceId);
      return { ent, usage: await getUsage(tx, ctx.workspaceId, ent) };
    }),
  ]);
  const atLimit = ent.limits.maxSocialAccounts >= 0 && usage.maxSocialAccounts >= ent.limits.maxSocialAccounts;

  return (
    <div className="grid grid-cols-1 gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Connected accounts</h1>
        <p className="text-sm text-muted-foreground" data-testid="account-usage">
          {usage.maxSocialAccounts} of {formatLimit(ent.limits.maxSocialAccounts)} accounts used on the {ent.plan.name} plan
        </p>
      </div>

      {q.connected ? <p role="status" className="rounded-md border border-green-600/30 bg-green-600/10 p-3 text-sm">Connected: {q.connected}{q.skipped ? `. Skipped (plan limit): ${q.skipped}` : ""}</p> : null}
      {q.error ? <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{q.error}</p> : null}

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Connect a platform</CardTitle>
            <CardDescription>
              {atLimit ? "You've reached your plan's account limit. Upgrade or disconnect an account to add more." : "You'll be sent to the platform to approve access."}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {PLATFORM_KEYS.map((p) => {
              const real = !!realPublisher(p);
              return (
                <Button key={p} asChild={!atLimit} variant="outline" disabled={atLimit} className="h-auto min-w-0 flex-col items-start gap-0.5 whitespace-normal py-3 text-left">
                  {atLimit ? (
                    <span>{PLATFORM_RULES[p].label}</span>
                  ) : (
                    <a href={`/api/social/connect/${p.toLowerCase()}`} data-testid={`connect-${p}`}>
                      <span className="font-medium">{PLATFORM_RULES[p].label}</span>
                      <span className="text-xs font-normal text-muted-foreground">{real ? "Live connection" : "Simulated (no app credentials)"}</span>
                    </a>
                  )}
                </Button>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>{accounts.length ? `${accounts.length} account${accounts.length === 1 ? "" : "s"}` : "No accounts yet"}</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 gap-3" data-testid="accounts-list">
          {accounts.map((a) => {
            const s = STATUS[a.status]!;
            return (
              <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3" data-testid={`account-${a.platform}`}>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {PLATFORM_RULES[a.platform].label} · <span className="truncate">{a.handle ?? a.displayName}</span>
                    <Badge variant={s.variant}>{s.label}</Badge>
                    {a.isMock ? <Badge variant="secondary">mock</Badge> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Connected {formatDate(a.createdAt)} · checked {a.lastHealthCheckAt ? a.lastHealthCheckAt.toISOString().slice(0, 16).replace("T", " ") : "never"}
                    {a.tokenExpiresAt ? ` · token expires ${a.tokenExpiresAt.toISOString().slice(0, 16).replace("T", " ")} (auto-refresh)` : ""}
                  </p>
                  {a.lastError ? <p className="text-xs text-destructive">{a.lastError}</p> : null}
                </div>
                {canManage ? (
                  <div className="flex flex-wrap items-start gap-2">
                    {a.status === "DISCONNECTED" || a.status === "EXPIRED" ? (
                      <Button asChild size="sm"><a href={`/api/social/connect/${a.platform.toLowerCase()}`}>Reconnect</a></Button>
                    ) : (
                      <ActionForm action={checkHealthAction} submitLabel="Check" pendingLabel="Checking…" variant="outline" className="flex flex-col gap-1">
                        <input type="hidden" name="accountId" value={a.id} />
                      </ActionForm>
                    )}
                    {a.status !== "DISCONNECTED" ? (
                      <ActionForm action={disconnectAction} submitLabel="Disconnect" pendingLabel="…" variant="ghost" className="flex flex-col gap-1">
                        <input type="hidden" name="accountId" value={a.id} />
                      </ActionForm>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
