import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { ActionForm } from "@/components/forms/action-form";
import { Field } from "@/components/forms/field";
import { PROVIDERS } from "@/server/ai/catalog";
import { listPlatformKeyStatus } from "@/server/ai/credentials";
import { getCreditCosts } from "@/server/settings";
import { requireSuperAdmin } from "@/server/tenancy/context";
import { removePlatformKeyAction, saveCreditCostsAction, savePlatformKeyAction } from "./actions";

export const metadata = { title: "AI providers" };
export const dynamic = "force-dynamic";

export default async function AdminAiPage() {
  await requireSuperAdmin();
  const [costs, keys] = await Promise.all([getCreditCosts(), listPlatformKeyStatus()]);
  return (
    <div className="grid grid-cols-1 gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">AI providers &amp; credits</h1>

      <Card>
        <CardHeader>
          <CardTitle>Credit cost per generation</CardTitle>
          <CardDescription>Deducted from a workspace&apos;s plan credits when platform keys are used. Workspaces using their own key pay nothing.</CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={saveCreditCostsAction} submitLabel="Save costs" className="grid gap-4 sm:grid-cols-4 sm:items-end">
            <Field name="TEXT" label="Text / caption" type="number" min={0} defaultValue={costs.TEXT} />
            <Field name="IMAGE" label="Image" type="number" min={0} defaultValue={costs.IMAGE} />
            <Field name="VIDEO" label="Video" type="number" min={0} defaultValue={costs.VIDEO} />
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Platform API keys</CardTitle>
          <CardDescription>
            Keys stored here are encrypted and take precedence over environment variables. Providers with no key are skipped;
            with no keys at all, generations use the mock provider.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2" data-testid="platform-keys">
            {keys.map((k) => (
              <div key={k.provider} className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
                <span className="flex items-center gap-2">
                  {k.label}
                  {k.db ? <Badge>stored ••••{k.db.last4}</Badge> : k.env ? <Badge variant="secondary">from {k.envKey}</Badge> : <Badge variant="outline">not configured</Badge>}
                </span>
                {k.db ? (
                  <ActionForm action={removePlatformKeyAction} submitLabel="Remove" pendingLabel="Removing…" variant="outline" className="flex items-center gap-2">
                    <input type="hidden" name="provider" value={k.provider} />
                  </ActionForm>
                ) : null}
              </div>
            ))}
          </div>
          <ActionForm action={savePlatformKeyAction} submitLabel="Save key" className="grid gap-3 sm:grid-cols-[14rem_1fr_auto] sm:items-end">
            <div className="grid gap-2">
              <Label htmlFor="pk-provider">Provider</Label>
              <NativeSelect id="pk-provider" name="provider">
                {keys.map((k) => <option key={k.provider} value={k.provider}>{PROVIDERS[k.provider].label}</option>)}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pk-key">API key</Label>
              <Input id="pk-key" name="apiKey" type="password" autoComplete="off" required />
            </div>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
