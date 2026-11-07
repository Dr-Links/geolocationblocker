import { PLATFORM_RULES } from "@/lib/platforms";

/** Publish success rate per platform: a magnitude (one hue), always labelled with the number. */
export function RateMeters({ rows }: { rows: { platform: string; published: number; failed: number; total: number; rate: number }[] }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">No publishing activity in this period.</p>;
  return (
    <ul className="grid gap-3" data-testid="rate-meters">
      {rows.map((r) => {
        const pct = Math.round(r.rate * 100);
        return (
          <li key={r.platform} className="grid gap-1">
            <div className="flex justify-between gap-2 text-sm">
              <span>{PLATFORM_RULES[r.platform as keyof typeof PLATFORM_RULES]?.label ?? r.platform}</span>
              <span className="tabular-nums text-muted-foreground">{pct}% · {r.published} of {r.total}{r.failed ? ` (${r.failed} failed)` : ""}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-label={`${r.platform} success rate`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full" style={{ width: `${pct === 0 ? 0 : Math.max(2, pct)}%`, background: "var(--series-1)" }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
