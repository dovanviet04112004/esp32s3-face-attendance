const kCurrency = "VND";

// ICU carries the unit word in both catalogues' languages, so no key is needed.
function unit(locale: string, name: string, display: "short" | "long"): Intl.NumberFormat {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: name,
    unitDisplay: display,
    maximumFractionDigits: 1,
  });
}

export function dayOnly(iso: string): Date {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  return new Date(year, month - 1, day);
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
