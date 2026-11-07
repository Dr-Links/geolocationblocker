import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** KPI tile: one number is its own form; no chart needed. */
export function Stat({ label, value, hint, testId }: { label: string; value: React.ReactNode; hint?: React.ReactNode; testId?: string }) {
  return (
    <Card>
      <CardHeader className="gap-1 pb-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums sm:text-3xl" data-testid={testId}>{value}</CardTitle>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardHeader>
    </Card>
  );
}
