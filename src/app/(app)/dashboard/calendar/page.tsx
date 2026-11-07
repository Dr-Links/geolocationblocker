import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { ActionForm } from "@/components/forms/action-form";
import { daysInMonth, formatInTz, toZoned, zonedToUtc } from "@/lib/time";
import { cn } from "@/lib/utils";
import { listCalendar } from "@/server/scheduling/posts";
import { parseSlots } from "@/server/scheduling/queue-slots";
import { can } from "@/server/tenancy/permissions";
import { requireTenant } from "@/server/tenancy/context";
import { addSlotAction, removeSlotAction } from "./actions";

export const metadata = { title: "Calendar" };
export const dynamic = "force-dynamic";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SHORT: Record<string, string> = { X: "X", INSTAGRAM: "IG", FACEBOOK: "FB", LINKEDIN: "in", TIKTOK: "TT", YOUTUBE: "YT" };
const CHIP: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground", SCHEDULED: "bg-sky-500/15 text-sky-800 dark:text-sky-300", PUBLISHING: "bg-amber-500/20 text-amber-800 dark:text-amber-300",
  PUBLISHED: "bg-green-600/15 text-green-800 dark:text-green-300", PARTIALLY_PUBLISHED: "bg-orange-500/20 text-orange-800 dark:text-orange-300", FAILED: "bg-destructive/15 text-destructive",
};

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const ctx = await requireTenant("workspace.view");
  const ws = await ctx.db.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { timezone: true, queueSlots: true } });
  const tz = ws.timezone;
  const { month } = await searchParams;
  const today = toZoned(new Date(), tz);
  const [y, m] = /^\d{4}-\d{2}$/.test(month ?? "") ? month!.split("-").map(Number) as [number, number] : [today.year, today.month];

  const from = zonedToUtc({ year: y, month: m, day: 1, hour: 0, minute: 0 }, tz);
  const nextM = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  const prevM = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  const to = zonedToUtc({ year: nextM.y, month: nextM.m, day: 1, hour: 0, minute: 0 }, tz);
  const posts = await listCalendar(ctx, from, to);

  // Bucket by local day.
  const byDay = new Map<number, typeof posts>();
  for (const p of posts) {
    const when = p.schedule?.scheduledAt ?? p.publishedAt;
    if (!when) continue;
    const z = toZoned(when, tz);
    if (z.year !== y || z.month !== m) continue;
    byDay.set(z.day, [...(byDay.get(z.day) ?? []), p].sort((a, b) => +(a.schedule?.scheduledAt ?? 0) - +(b.schedule?.scheduledAt ?? 0)));
  }
  const firstWeekday = toZoned(from, tz).weekday; // 1..7
  const nDays = daysInMonth(y, m);
  const cells = [...Array.from({ length: firstWeekday - 1 }, () => null), ...Array.from({ length: nDays }, (_, i) => i + 1)];
  const monthLabel = formatInTz(zonedToUtc({ year: y, month: m, day: 15, hour: 12, minute: 0 }, tz), tz, { month: "long", year: "numeric" });
  const key = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, "0")}`;
  const slots = parseSlots(ws.queueSlots);
  const canEdit = can(ctx.role, "workspace.update");

  const chip = (p: (typeof posts)[number]) => {
    const when = p.schedule?.scheduledAt ?? p.publishedAt!;
    return (
      <Link key={p.id} href={p.status === "PUBLISHED" || p.status === "PARTIALLY_PUBLISHED" ? `/dashboard/posts?tab=published` : `/dashboard/compose?post=${p.id}`}
        className={cn("block truncate rounded px-1.5 py-0.5 text-xs", CHIP[p.status])} data-testid="calendar-chip" title={p.content}>
        {formatInTz(when, tz, { timeStyle: "short" })} {p.targets.map((t) => SHORT[t.socialAccount.platform]).join("+")} · {p.content || "(media)"}
      </Link>
    );
  };

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="calendar-month">{monthLabel}</h1>
          <p className="text-sm text-muted-foreground">Times shown in {tz}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="icon"><Link href={`/dashboard/calendar?month=${key(prevM.y, prevM.m)}`} aria-label="Previous month"><ChevronLeft /></Link></Button>
          <Button asChild variant="outline" size="sm"><Link href="/dashboard/calendar">Today</Link></Button>
          <Button asChild variant="outline" size="icon"><Link href={`/dashboard/calendar?month=${key(nextM.y, nextM.m)}`} aria-label="Next month"><ChevronRight /></Link></Button>
          <Button asChild size="sm"><Link href="/dashboard/compose">New post</Link></Button>
        </div>
      </div>

      {/* Month grid (desktop) */}
      <div className="hidden overflow-hidden rounded-lg border md:block">
        <div className="grid grid-cols-7 border-b bg-muted/50 text-xs font-medium text-muted-foreground">
          {WEEKDAYS.map((d) => <div key={d} className="px-2 py-1.5">{d}</div>)}
        </div>
        <div className="grid grid-cols-7" data-testid="calendar-grid">
          {cells.map((d, i) => (
            <div key={i} className={cn("min-h-28 min-w-0 border-b border-r p-1.5", !d && "bg-muted/30", d === today.day && y === today.year && m === today.month && "bg-accent/60")}>
              {d ? <div className="mb-1 text-xs text-muted-foreground">{d}</div> : null}
              <div className="grid gap-1">{d ? byDay.get(d)?.map(chip) : null}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Agenda (mobile) */}
      <div className="grid gap-3 md:hidden" data-testid="calendar-agenda">
        {[...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([d, list]) => (
          <div key={d} className="grid gap-1">
            <p className="text-sm font-medium">{formatInTz(zonedToUtc({ year: y, month: m, day: d, hour: 12, minute: 0 }, tz), tz, { weekday: "short", month: "short", day: "numeric" })}</p>
            {list.map(chip)}
          </div>
        ))}
        {byDay.size === 0 ? <p className="text-sm text-muted-foreground">Nothing scheduled this month.</p> : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Posting queue</CardTitle>
          <CardDescription>&quot;Add to queue&quot; in the composer puts a post into the next free slot ({tz}).</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4">
          <div className="flex flex-wrap gap-2" data-testid="queue-slots">
            {slots.length === 0 ? <span className="text-sm text-muted-foreground">No slots yet.</span> : null}
            {slots.map((s) => (
              <span key={`${s.day}-${s.time}`} className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm">
                {WEEKDAYS[s.day - 1]} {s.time}
                {canEdit ? (
                  <ActionForm action={removeSlotAction} submitLabel="×" pendingLabel="…" variant="ghost" className="contents">
                    <input type="hidden" name="slot" value={`${s.day}-${s.time}`} />
                  </ActionForm>
                ) : null}
              </span>
            ))}
          </div>
          {canEdit ? (
            <ActionForm action={addSlotAction} submitLabel="Add slots" className="flex flex-wrap items-end gap-3">
              <fieldset className="grid gap-2">
                <legend className="mb-2 text-sm font-medium">Days</legend>
                <div className="flex flex-wrap gap-1">
                  {WEEKDAYS.map((d, i) => (
                    <label key={d} className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
                      <input type="checkbox" name="day" value={i + 1} className="size-3.5" defaultChecked={i < 5} /> {d}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="grid gap-2">
                <Label htmlFor="slot-time">Time</Label>
                <Input id="slot-time" name="time" type="time" defaultValue="09:00" className="w-32" />
              </div>
            </ActionForm>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
