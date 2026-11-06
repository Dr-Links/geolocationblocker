import { formatLimit } from "@/lib/format";
import type { Entitlements, Usage } from "@/server/billing/entitlements";
import { cn } from "@/lib/utils";

const ROWS = [
  { key: "maxPostsPerMonth", label: "Posts this period", used: (u: Usage) => u.maxPostsPerMonth },
  { key: "monthlyCredits", label: "AI credits this period", used: (u: Usage) => u.creditsUsed },
  { key: "maxSocialAccounts", label: "Connected accounts", used: (u: Usage) => u.maxSocialAccounts },
  { key: "maxMembers", label: "Member seats (incl. pending invites)", used: (u: Usage) => u.maxMembers },
] as const;

export function UsageMeters({ ent, usage }: { ent: Pick<Entitlements, "limits">; usage: Usage }) {
  return (
    <div className="grid gap-4" data-testid="usage-meters">
      {ROWS.map((r) => {
        const max = ent.limits[r.key];
        const used = r.used(usage);
        const pct = max < 0 ? 0 : max === 0 ? 100 : Math.min(100, Math.round((used / max) * 100));
        return (
          <div key={r.key} className="grid gap-1.5">
            <div className="flex justify-between text-sm">
              <span>{r.label}</span>
              <span className="tabular-nums text-muted-foreground" data-testid={`usage-${r.key}`}>
                {used.toLocaleString("en-US")} / {formatLimit(max)}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={r.label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className={cn("h-full rounded-full", pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-amber-500" : "bg-primary")} style={{ width: `${max < 0 ? 4 : pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
