import { env } from "@/lib/env";

const kCurrency = "VND";
const kZone = env.NEXT_PUBLIC_APP_TIMEZONE;
const kMinuteMs = 60_000;
const kMinutesPerHour = 60;

// ICU carries the unit word in both catalogues' languages, so no key is needed.
function unit(locale: string, name: string, display: "short" | "long"): Intl.NumberFormat {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: name,
    unitDisplay: display,
    maximumFractionDigits: 1,
  });
}

/** A date-only value as UTC noon, which every zone from UTC-11 to UTC+11 reads as that day (KEHOACH 9.8). */
export function dayOnly(iso: string): Date {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

const dayParts = new Intl.DateTimeFormat("en-CA", { timeZone: kZone, year: "numeric", month: "2-digit", day: "2-digit" });
const clockParts = new Intl.DateTimeFormat("en-GB", { timeZone: kZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** The company's calendar day an instant falls on, `YYYY-MM-DD`, whatever zone the browser is in. */
export function dayOf(at: Date | string | number): string {
  return dayParts.format(new Date(at));
}

export function todayIso(): string {
  return dayOf(new Date());
}

export function addDays(day: string, count: number): string {
  const at = dayOnly(day);
  at.setUTCDate(at.getUTCDate() + count);
  return at.toISOString().slice(0, 10);
}

/** The first day of the company's month `offset` months from the one `day` is in. */
export function monthStart(offset = 0, day: string = todayIso()): string {
  const [year, month] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 10);
}

export function clockAt(at: Date | string | number): string {
  return clockParts.format(new Date(at));
}

const wallParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: kZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function offsetMs(at: number): number {
  const parts = wallParts.formatToParts(new Date(at));
  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"), read("second")) - at;
}

/** A company wall-clock time on a company day as the instant it is, e.g. where a shift starts. */
export function atClock(day: string, clock = "00:00"): Date {
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute] = clock.split(":").map(Number);
  const naive = Date.UTC(year, month - 1, date) + ((hour || 0) * kMinutesPerHour + (minute || 0)) * kMinuteMs;
  return new Date(naive - offsetMs(naive - offsetMs(naive)));
}

export function dayWindow(day: string): { from: Date; to: Date } {
  return { from: atClock(day), to: atClock(addDays(day, 1)) };
}

type Stamp = { hour: "2-digit"; minute: "2-digit"; day?: "numeric"; month?: "numeric"; year?: "numeric" };

/** As much of an instant as a live row needs: the clock today, the date on another day, the year in another year. */
export function stampOptions(at: Date | string | number): Stamp {
  const day = dayOf(at);
  const today = todayIso();
  const clock = { hour: "2-digit", minute: "2-digit" } as const;
  if (day === today) {
    return clock;
  }
  return day.slice(0, 4) === today.slice(0, 4)
    ? { day: "numeric", month: "numeric", ...clock }
    : { day: "numeric", month: "numeric", year: "numeric", ...clock };
}

// The Devices page warns past two minutes (KEHOACH 9.8).
const kSkewWarnMs = 120_000;

export function clockDrifts(skewMs: number | null | undefined): boolean {
  return typeof skewMs === "number" && Math.abs(skewMs) > kSkewWarnMs;
}

/** Dong, whole units only, since the currency has no minor unit in practice. */
export function money(amount: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: kCurrency,
    maximumFractionDigits: 0,
  }).format(amount);
}

/** Work recorded in minutes, read as hours, which is how a timesheet is read. */
export function hours(minutes: number, locale: string): string {
  return unit(locale, "hour", "short").format(minutes / 60);
}

export function minutes(count: number, locale: string): string {
  return unit(locale, "minute", "short").format(count);
}

export function days(count: number, locale: string): string {
  return unit(locale, "day", "long").format(count);
}

export function percent(fraction: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(
    fraction,
  );
}

/** A shift's wall-clock "HH:mm" read in the locale's own clock, as punch times already are. */
export function clockOf(time: string, locale: string): string {
  const [hour, minute] = time.split(":").map(Number);
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(
    new Date(Date.UTC(1970, 0, 1, hour ?? 0, minute ?? 0)),
  );
}
