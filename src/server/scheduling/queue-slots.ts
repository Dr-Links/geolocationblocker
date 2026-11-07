import { z } from "zod";
import { toZoned, zonedToUtc } from "@/lib/time";

/** Weekly posting slots ("Add to queue" picks the next free one), in the workspace timezone. */

export const slotSchema = z.object({
  day: z.coerce.number().int().min(1).max(7), // 1 = Monday … 7 = Sunday
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm"),
});
export const slotsSchema = z.array(slotSchema).max(50);
export type Slot = z.infer<typeof slotSchema>;

export function parseSlots(json: unknown): Slot[] {
  const r = slotsSchema.safeParse(json);
  if (!r.success) return [];
  const seen = new Set<string>();
  return r.data
    .filter((s) => !seen.has(`${s.day}-${s.time}`) && seen.add(`${s.day}-${s.time}`))
    .sort((a, b) => a.day - b.day || a.time.localeCompare(b.time));
}

/**
 * Next slot instant strictly after `after` (plus a 1-minute buffer) that isn't
 * already taken by a scheduled post. Looks up to 12 weeks ahead.
 */
export function nextFreeSlot(slots: Slot[], tz: string, after: Date, taken: Set<number>): Date | null {
  if (!slots.length) return null;
  const start = toZoned(after, tz);
  const floor = after.getTime() + 60_000;
  for (let dayOffset = 0; dayOffset < 7 * 12; dayOffset++) {
    const d = new Date(Date.UTC(start.year, start.month - 1, start.day + dayOffset));
    const weekday = ((d.getUTCDay() + 6) % 7) + 1;
    for (const s of slots.filter((x) => x.day === weekday)) {
      const [hour, minute] = s.time.split(":").map(Number) as [number, number];
      const at = zonedToUtc({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour, minute }, tz);
      if (at.getTime() > floor && !taken.has(at.getTime())) return at;
    }
  }
  return null;
}
