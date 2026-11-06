import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Field } from "@/components/forms/field";

const LIMITS = [
  ["maxPostsPerMonth", "Posts"],
  ["monthlyCredits", "AI credits"],
  ["maxSocialAccounts", "Accounts"],
  ["maxMembers", "Members"],
] as const;
const FEATURES = [
  ["video", "AI video"],
  ["byok", "Own AI keys"],
  ["recurring", "Recurring posts"],
] as const;

/** Shared by "comp workspace" and "create comped account": plan + optional partial overrides + reason + expiry. */
export function CompFields({ plans, errors }: { plans: { id: string; name: string }[]; errors?: Record<string, string[] | undefined> }) {
  return (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <Label htmlFor="planId">Plan to grant</Label>
        <NativeSelect id="planId" name="planId" required defaultValue={plans.find((p) => p.name === "Pro")?.id}>
          {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </NativeSelect>
      </div>
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-medium">Partial comp: override limits or features (optional)</summary>
        <p className="mt-2 text-xs text-muted-foreground">Leave blank to use the plan&apos;s value. -1 = unlimited.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          {LIMITS.map(([k, label]) => <Field key={k} name={`ov_${k}`} label={label} type="number" min={-1} placeholder="plan default" />)}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {FEATURES.map(([k, label]) => (
            <div key={k} className="grid gap-2">
              <Label htmlFor={`ovf_${k}`}>{label}</Label>
              <NativeSelect id={`ovf_${k}`} name={`ovf_${k}`} defaultValue="inherit">
                <option value="inherit">Plan default</option>
                <option value="on">Enabled</option>
                <option value="off">Disabled</option>
              </NativeSelect>
            </div>
          ))}
        </div>
      </details>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="reason" label="Reason (audit log)" required placeholder="e.g. Launch partner, nonprofit" errors={errors?.reason} />
        <Field name="expiresAt" label="Expires (optional)" type="date" hint="Blank = never. After expiry the workspace falls back to its paid plan or Free." errors={errors?.expiresAt} />
      </div>
    </div>
  );
}
