import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { ActionForm } from "@/components/forms/action-form";
import { withTenantTx } from "@/lib/db";
import { PROVIDERS, REAL_PROVIDERS, providersFor } from "@/server/ai/catalog";
import { listWorkspaceKeys } from "@/server/ai/credentials";
import { parsePreferences } from "@/server/ai/preferences";
import { getEntitlements } from "@/server/billing/entitlements";
import { can } from "@/server/tenancy/permissions";
import { requireTenant } from "@/server/tenancy/context";
import { removeKeyAction, saveKeyAction, savePreferencesAction } from "./actions";

export const metadata = { title: "AI settings" };
export const dynamic = "force-dynamic";

const TYPES = [
  ["TEXT", "Captions & post copy"],
  ["IMAGE", "Images"],
  ["VIDEO", "Short videos"],
] as const;

export default async function AiSettingsPage() {
  const ctx = await requireTenant("workspace.view");
  const canEdit = can(ctx.role, "settings.ai");
  const [ws, keys, ent] = await Promise.all([
    ctx.db.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { aiPreferences: true } }),
    listWorkspaceKeys(ctx),
    withTenantTx(ctx.workspaceId, (tx) => getEntitlements(tx, ctx.workspaceId)),
  ]);
  const prefs = parsePreferences(ws.aiPreferences);

  return (
    <div className="grid grid-cols-1 gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">AI settings</h1>
      <Card>
        <CardHeader>
          <CardTitle>Default provider &amp; model</CardTitle>
          <CardDescription>Used for every generation unless overridden in the composer. &quot;Automatic&quot; picks the first available provider.</CardDescription>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <ActionForm action={savePreferencesAction} submitLabel="Save defaults">
              {TYPES.map(([t, label]) => (
                <div key={t} className="grid gap-3 sm:grid-cols-3 sm:items-end">
                  <p className="text-sm font-medium">{label}</p>
                  <div className="grid gap-2">
                    <Label htmlFor={`${t}_provider`}>Provider</Label>
                    <NativeSelect id={`${t}_provider`} name={`${t}_provider`} defaultValue={prefs[t].provider}>
                      <option value="AUTO">Automatic</option>
                      {providersFor(t).map((p) => <option key={p} value={p}>{PROVIDERS[p].label}</option>)}
                    </NativeSelect>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={`${t}_model`}>Model (optional)</Label>
                    <Input id={`${t}_model`} name={`${t}_model`} defaultValue={prefs[t].model ?? ""} placeholder="provider default" />
                  </div>
                </div>
              ))}
            </ActionForm>
          ) : (
            <p className="text-sm text-muted-foreground">Only workspace admins can change AI defaults.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">Your own API keys {ent.features.byok ? null : <Badge variant="secondary">Upgrade required</Badge>}</CardTitle>
          <CardDescription>
            Bring your own key: generations with that provider are billed to your provider account and use none of your plan&apos;s credits.
            Keys are encrypted and never shown again.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {keys.length ? (
            <div className="grid gap-2" data-testid="byok-keys">
              {keys.map((k) => (
                <div key={k.provider} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
                  <span>{PROVIDERS[k.provider].label} · <span className="font-mono">••••{k.last4}</span></span>
                  {canEdit ? (
                    <ActionForm action={removeKeyAction} submitLabel="Remove" pendingLabel="Removing…" variant="outline" className="flex items-center gap-2">
                      <input type="hidden" name="provider" value={k.provider} />
                    </ActionForm>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {canEdit && ent.features.byok ? (
            <ActionForm action={saveKeyAction} submitLabel="Save key" className="grid gap-3 sm:grid-cols-[12rem_1fr_auto] sm:items-end">
              <div className="grid gap-2">
                <Label htmlFor="byok-provider">Provider</Label>
                <NativeSelect id="byok-provider" name="provider">
                  {REAL_PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDERS[p].label}</option>)}
                </NativeSelect>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="byok-key">API key</Label>
                <Input id="byok-key" name="apiKey" type="password" autoComplete="off" required />
              </div>
            </ActionForm>
          ) : !ent.features.byok ? (
            <p className="text-sm text-muted-foreground">Your plan doesn&apos;t include bring-your-own-key. <a className="underline" href="/dashboard/billing">See plans</a>.</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
