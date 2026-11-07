import { daysInMonth, toZoned, zonedToUtc } from "./time";

/**
 * Small, explicit recurrence subset (RFC 5545 RRULE syntax):
 *   FREQ=DAILY|WEEKLY|MONTHLY; INTERVAL=n; BYDAY=MO,WE (weekly); UNTIL=YYYYMMDD
 * Occurrences keep the same WALL-CLOCK time in the post's timezone, so a 9:00
 * weekly post stays at 9:00 across DST changes.
 */

export type Freq = "DAILY" | "WEEKLY" | "MONTHLY";
export const DAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type DayCode = (typeof DAY_CODES)[number];

export interface Recurrence {
  freq: Freq;
  interval: number;
  byDay?: DayCode[];
  until?: string; // YYYY-MM-DD (inclusive, in the post's timezone)
}

export function parseRule(rule: string | null | undefined): Recurrence | null {
  if (!rule) return null;
  const kv = Object.fromEntries(rule.split(";").map((p) => p.split("=") as [string, string]).filter(([k, v]) => k && v));
  const freq = kv.FREQ as Freq;
  if (!["DAILY", "WEEKLY", "MONTHLY"].includes(freq)) return null;
  const interval = Math.min(52, Math.max(1, Number(kv.INTERVAL ?? 1) || 1));
  const byDay = kv.BYDAY ? (kv.BYDAY.split(",").filter((d) => (DAY_CODES as readonly string[]).includes(d)) as DayCode[]) : undefined;
  const until = kv.UNTIL && /^\d{8}$/.test(kv.UNTIL) ? `${kv.UNTIL.slice(0, 4)}-${kv.UNTIL.slice(4, 6)}-${kv.UNTIL.slice(6, 8)}` : undefined;
  return { freq, interval, byDay: freq === "WEEKLY" && byDay?.length ? byDay : undefined, until };
}

export function formatRule(r: Recurrence): string {
  return [
    `FREQ=${r.freq}`,
    r.interval > 1 ? `INTERVAL=${r.interval}` : null,
    r.freq === "WEEKLY" && r.byDay?.length ? `BYDAY=${r.byDay.join(",")}` : null,
    r.until ? `UNTIL=${r.until.replaceAll("-", "")}` : null,
  ]
    .filter(Boolean)
    .join(";");
}

export function describeRule(rule: string | null | undefined): string | null {
  const r = parseRule(rule);
  if (!r) return null;
  const every = r.interval === 1 ? "" : ` ${r.interval}`;
  const unit = { DAILY: "day", WEEKLY: "week", MONTHLY: "month" }[r.freq];
  const days = r.byDay ? ` on ${r.byDay.map((d) => d[0] + d[1]!.toLowerCase()).join(", ")}` : "";
  return `Every${every} ${unit}${r.interval > 1 ? "s" : ""}${days}${r.until ? ` until ${r.until}` : ""}`;
}

/** Next occurrence strictly after `current` (an occurrence), or null when the series ends. */
export function nextOccurrence(current: Date, rule: string, tz: string): Date | null {
  const r = parseRule(rule);
  if (!r) return null;
  const z = toZoned(current, tz);
  const at = (y: number, m: number, d: number) => zonedToUtc({ year: y, month: m, day: d, hour: z.hour, minute: z.minute }, tz);
  const addDays = (n: number) => {
    const d = new Date(Date.UTC(z.year, z.month - 1, z.day + n));
    return at(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  };

  let next: Date;
  if (r.freq === "DAILY") next = addDays(r.interval);
  else if (r.freq === "MONTHLY") {
    const total = z.month - 1 + r.interval;
    const y = z.year + Math.floor(total / 12);
    const m = (total % 12) + 1;
    next = at(y, m, Math.min(z.day, daysInMonth(y, m))); // Jan 31 → Feb 28
  } else {
    const days = (r.byDay ?? [DAY_CODES[z.weekday - 1]!]).map((d) => DAY_CODES.indexOf(d) + 1).sort((a, b) => a - b);
    const laterThisWeek = days.find((d) => d > z.weekday);
    next = laterThisWeek ? addDays(laterThisWeek - z.weekday) : addDays(7 * (r.interval - 1) + (7 - z.weekday) + days[0]!);
  }

  if (r.until) {
    const n = toZoned(next, tz);
    const key = `${n.year}-${String(n.month).padStart(2, "0")}-${String(n.day).padStart(2, "0")}`;
    if (key > r.until) return null;
  }
  return next;
}
