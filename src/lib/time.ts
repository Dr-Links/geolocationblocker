/**
 * Timezone math with only Intl (no dependency). Wall-clock times are
 * "YYYY-MM-DDTHH:mm" strings interpreted in an IANA timezone.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 1=Mon … 7=Sun (ISO)
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function isValidTimezone(tz: string) {
  try {
    fmt(tz);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock fields of an instant in a timezone. */
export function toZoned(date: Date, tz: string): ZonedParts {
  const parts = Object.fromEntries(fmt(tz).formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WD[parts.weekday!]!,
  };
}

/** Offset (ms) of tz from UTC at an instant: local = utc + offset. */
function offsetAt(date: Date, tz: string) {
  const z = toZoned(date, tz);
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Convert a wall-clock time in `tz` to the UTC instant.
 * DST gaps (e.g. 02:30 on spring-forward day) resolve to the time after the gap;
 * ambiguous times (fall-back) resolve to the earlier occurrence.
 */
export function zonedToUtc(local: { year: number; month: number; day: number; hour: number; minute: number }, tz: string): Date {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  // Two passes handle offsets that change between the guess and the answer.
  let t = guess - offsetAt(new Date(guess), tz);
  t = guess - offsetAt(new Date(t), tz);
  const back = toZoned(new Date(t), tz);
  if (back.hour !== local.hour || back.minute !== local.minute) {
    // In a DST gap: the wall time doesn't exist. Interpreting it with the offset from
    // BEFORE the gap lands the same distance past the gap (02:30 → 03:30 on spring-forward).
    return new Date(guess - offsetAt(new Date(t - 3 * 3600_000), tz));
  }
  // Ambiguous (fall back): prefer the earlier instant if it maps to the same wall time.
  const earlier = t - 3600_000;
  const e = toZoned(new Date(earlier), tz);
  if (e.hour === local.hour && e.minute === local.minute && e.day === local.day) return new Date(earlier);
  return new Date(t);
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function parseLocal(s: string) {
  const m = LOCAL_RE.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  return { year: y, month: mo, day: d, hour: h, minute: mi };
}

export function localToUtc(local: string, tz: string): Date | null {
  const p = parseLocal(local);
  return p ? zonedToUtc(p, tz) : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DDTHH:mm" in tz (for <input type="datetime-local">). */
export function utcToLocalInput(date: Date, tz: string) {
  const z = toZoned(date, tz);
  return `${z.year}-${pad(z.month)}-${pad(z.day)}T${pad(z.hour)}:${pad(z.minute)}`;
}

export function formatInTz(date: Date, tz: string, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).format(date);
}

/** Days in a month (1-12). */
export const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
