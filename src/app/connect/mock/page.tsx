import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CenteredShell } from "@/components/app/centered-shell";
import { Field } from "@/components/forms/field";
import { PLATFORM_RULES, isPlatform } from "@/lib/platforms";
import { redirectUriFor } from "@/server/social/accounts";
import { requireUser } from "@/server/tenancy/context";

export const metadata = { title: "Authorize (simulated)" };
export const dynamic = "force-dynamic";

/** Stand-in for a platform's OAuth consent screen when its app credentials aren't configured. */
export default async function MockConsentPage({ searchParams }: { searchParams: Promise<{ platform?: string; state?: string; redirect_uri?: string }> }) {
  await requireUser();
  const { platform = "", state = "", redirect_uri } = await searchParams;
  const valid = isPlatform(platform) && !!state && redirect_uri === redirectUriFor(platform);
  if (!valid) {
    return (
      <CenteredShell>
        <Card><CardHeader><CardTitle>Invalid authorization request</CardTitle><CardDescription>Start again from Connected accounts.</CardDescription></CardHeader></Card>
      </CenteredShell>
    );
  }
  const label = PLATFORM_RULES[platform].label;
  return (
    <CenteredShell>
      <Card>
        <CardHeader>
          <p className="w-fit rounded bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">SIMULATED · no {label} app configured</p>
          <CardTitle className="text-2xl">Authorize Postpilot on {label}</CardTitle>
          <CardDescription>Postpilot wants to publish posts and read basic profile info for the account below.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action="/connect/mock/authorize" method="post" className="grid gap-4">
            <input type="hidden" name="platform" value={platform} />
            <input type="hidden" name="state" value={state} />
            <Field name="handle" label={`${label} account handle`} defaultValue="acme_demo" hint="Any name: this simulates the account you'd log into." />
            <div className="flex gap-2">
              <Button type="submit" name="decision" value="allow">Authorize</Button>
              <Button type="submit" name="decision" value="deny" variant="outline">Cancel</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </CenteredShell>
  );
}
