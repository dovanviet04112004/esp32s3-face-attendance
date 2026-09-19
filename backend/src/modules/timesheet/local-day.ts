/** Instant to local day and back; every timesheet boundary passes through here. */
const MINUTES_PER_HOUR = 60;

export function localDay(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Minutes past local midnight, what a shift's "08:00" compares to. */
export function minutesIntoDay(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
  const [hour, minute] = parts.split(":").map(Number);
  return hour * MINUTES_PER_HOUR + minute;
}

export function clockToMinutes(clock: string): number {
  const [hour, minute] = clock.split(":").map(Number);
  return hour * MINUTES_PER_HOUR + (minute || 0);
}

/** The UTC instants bounding one local calendar day. */
export function dayWindow(day: string, zone: string): { from: Date; to: Date } {
  return { from: startOfLocalDay(day, zone), to: startOfLocalDay(nextDay(day), zone) };
}

export function dayAsDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function nextDay(day: string): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}

// Guess the offset, then correct once: exact without a timezone library.
function startOfLocalDay(day: string, zone: string): Date {
  const naive = new Date(`${day}T00:00:00.000Z`);
  const guess = new Date(naive.getTime() - offsetMinutes(naive, zone) * 60_000);
  return new Date(naive.getTime() - offsetMinutes(guess, zone) * 60_000);
}

function offsetMinutes(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour") % 24, read("minute"), read("second"));
  return (asUtc - at.getTime()) / 60_000;
}
