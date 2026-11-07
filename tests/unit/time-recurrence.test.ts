import { describe, expect, it } from "vitest";
import { describeRule, formatRule, nextOccurrence, parseRule } from "@/lib/recurrence";
import { localToUtc, toZoned, utcToLocalInput } from "@/lib/time";

const NY = "America/New_York";

describe("timezone conversion", () => {
  it("converts wall-clock time to UTC in winter and summer", () => {
    expect(localToUtc("2026-01-15T09:00", NY)!.toISOString()).toBe("2026-01-15T14:00:00.000Z"); // EST −5
    expect(localToUtc("2026-07-15T09:00", NY)!.toISOString()).toBe("2026-07-15T13:00:00.000Z"); // EDT −4
    expect(localToUtc("2026-07-15T09:00", "Asia/Kolkata")!.toISOString()).toBe("2026-07-15T03:30:00.000Z");
    expect(localToUtc("2026-07-15T09:00", "UTC")!.toISOString()).toBe("2026-07-15T09:00:00.000Z");
  });

  it("DST gap (spring forward) moves past the gap; ambiguous time picks the earlier", () => {
    expect(localToUtc("2026-03-08T02:30", NY)!.toISOString()).toBe("2026-03-08T07:30:00.000Z"); // = 03:30 EDT
    expect(localToUtc("2026-11-01T01:30", NY)!.toISOString()).toBe("2026-11-01T05:30:00.000Z"); // first 01:30 (EDT)
  });

  it("round-trips through the datetime-local format", () => {
    const d = localToUtc("2026-12-31T23:45", "Europe/Berlin")!;
    expect(utcToLocalInput(d, "Europe/Berlin")).toBe("2026-12-31T23:45");
    expect(toZoned(d, "Europe/Berlin").weekday).toBe(4); // Thursday
  });

  it("rejects malformed input", () => {
    expect(localToUtc("2026-13-01T09:00", NY)).toBeNull();
    expect(localToUtc("tomorrow", NY)).toBeNull();
  });
});

describe("recurrence", () => {
  it("parses, formats and describes rules", () => {
    const r = parseRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;UNTIL=20261231")!;
    expect(r).toEqual({ freq: "WEEKLY", interval: 2, byDay: ["MO", "FR"], until: "2026-12-31" });
    expect(formatRule(r)).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;UNTIL=20261231");
    expect(describeRule("FREQ=DAILY")).toBe("Every day");
    expect(describeRule("FREQ=WEEKLY;BYDAY=MO,WE")).toBe("Every week on Mo, We");
    expect(parseRule("FREQ=HOURLY")).toBeNull();
  });

  it("daily keeps 9:00 local time across the DST change", () => {
    const sat = localToUtc("2026-03-07T09:00", NY)!; // EST
    const sun = nextOccurrence(sat, "FREQ=DAILY", NY)!;
    expect(sun.toISOString()).toBe("2026-03-08T13:00:00.000Z"); // 09:00 EDT
    expect(utcToLocalInput(sun, NY)).toBe("2026-03-08T09:00");
  });

  it("weekly with several days walks Mon → Wed → Fri → next Mon", () => {
    const rule = "FREQ=WEEKLY;BYDAY=MO,WE,FR";
    let d = localToUtc("2026-11-09T10:00", NY)!; // Monday
    const seen = [];
    for (let i = 0; i < 4; i++) {
      d = nextOccurrence(d, rule, NY)!;
      seen.push(utcToLocalInput(d, NY));
    }
    expect(seen).toEqual(["2026-11-11T10:00", "2026-11-13T10:00", "2026-11-16T10:00", "2026-11-18T10:00"]);
  });

  it("every 2 weeks skips a week after the last day", () => {
    const d = localToUtc("2026-11-13T10:00", NY)!; // Friday
    expect(utcToLocalInput(nextOccurrence(d, "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR", NY)!, NY)).toBe("2026-11-23T10:00");
  });

  it("monthly clamps to the end of shorter months", () => {
    const jan31 = localToUtc("2027-01-31T08:00", "UTC")!;
    expect(utcToLocalInput(nextOccurrence(jan31, "FREQ=MONTHLY", "UTC")!, "UTC")).toBe("2027-02-28T08:00");
  });

  it("stops after UNTIL", () => {
    const d = localToUtc("2026-12-30T09:00", NY)!;
    expect(nextOccurrence(d, "FREQ=DAILY;UNTIL=20261231", NY)).not.toBeNull();
    expect(nextOccurrence(nextOccurrence(d, "FREQ=DAILY;UNTIL=20261231", NY)!, "FREQ=DAILY;UNTIL=20261231", NY)).toBeNull();
  });
});
