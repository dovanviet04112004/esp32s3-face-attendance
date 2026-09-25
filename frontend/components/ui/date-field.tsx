"use client";

import { Button, DatePicker, Field, Input, Label, Popover } from "@cloudflare/kumo";
import { CalendarBlankIcon } from "@phosphor-icons/react";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useId, useState, useSyncExternalStore, type ReactNode } from "react";

import { useOptional } from "@/components/ui/optional";
import { cn } from "@/lib/cn";
import { dayOnly, todayIso } from "@/lib/format";

const DESK = "(pointer: fine) and (min-width: 48rem)";

function useDesk(): boolean {
  const listen = useCallback((again: () => void) => {
    const query = window.matchMedia(DESK);
    query.addEventListener("change", again);
    return () => query.removeEventListener("change", again);
  }, []);
  return useSyncExternalStore(
    listen,
    () => window.matchMedia(DESK).matches,
    () => true,
  );
}

// The calendar hands back the browser's local midnight of the day clicked, so it is read locally.
function isoOf(day: Date): string {
  const pad = (one: number) => String(one).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

interface Props {
  label: string;
  description?: ReactNode;
  error?: string;
  value: string;
  onChange: (next: string) => void;
  min?: string;
  max?: string;
  required?: boolean;
  disabled?: boolean;
  hideLabel?: boolean;
}

function DeskDateField({ label, description, error, value, onChange, min, max, required, disabled, hideLabel }: Props) {
  const t = useTranslations("common");
  const format = useFormatter();
  const optional = useOptional();
  const id = useId();
  const [open, setOpen] = useState(false);
  const picked = value ? dayOnly(value) : undefined;
  const floor = min ? dayOnly(min) : undefined;
  const ceiling = max ? dayOnly(max) : undefined;
  const today = todayIso();
  const todayFits = (!min || today >= min) && (!max || today <= max);
  const opensOn = picked ?? (min && today < min ? floor : max && today > max ? ceiling : undefined);

  function choose(next: string): void {
    onChange(next);
    setOpen(false);
  }

  return (
    <Field
      label={label}
      hideLabel
      required={required === false ? undefined : required}
      description={description}
      error={error ? { message: error, match: true } : undefined}
    >
      {hideLabel ? null : <Label htmlFor={id}>{required === false ? optional(label) : label}</Label>}
      <Popover open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          render={
            <Button
              id={id}
              variant="secondary"
              icon={CalendarBlankIcon}
              disabled={disabled}
              aria-label={hideLabel ? label : undefined}
              className={cn("w-full justify-start font-normal tabular-nums", error && "ring-kumo-danger")}
            >
              {picked ? format.dateTime(picked, "day") : <span className="text-kumo-placeholder">{t("pickDate")}</span>}
            </Button>
          }
        />
        <Popover.Content className="p-3">
          <DatePicker
            mode="single"
            selected={picked}
            defaultMonth={opensOn}
            startMonth={floor}
            endMonth={ceiling}
            disabled={[...(floor ? [{ before: floor }] : []), ...(ceiling ? [{ after: ceiling }] : [])]}
            weekStartsOn={1}
            formatters={{
              formatCaption: (month) => format.dateTime(dayOnly(isoOf(month)), { month: "long", year: "numeric" }),
              formatWeekdayName: (day) => format.dateTime(dayOnly(isoOf(day)), { weekday: "narrow" }),
            }}
            labels={{ labelPrevious: () => t("earlier"), labelNext: () => t("later") }}
            onChange={(next) => (next ? choose(isoOf(next)) : undefined)}
          />
          <div className="mt-2 flex gap-2 border-t border-kumo-hairline pt-3">
            <Button variant="secondary" size="sm" disabled={!todayFits} onClick={() => choose(today)}>
              {t("today")}
            </Button>
            {required === false && value !== "" ? (
              <Button variant="ghost" size="sm" onClick={() => choose("")}>
                {t("clear")}
              </Button>
            ) : null}
          </div>
        </Popover.Content>
      </Popover>
    </Field>
  );
}

/** One date field: Kumo's calendar in a popover on a desk, the system's date wheel on a phone (KEHOACH 9.12).
 *  @param value `YYYY-MM-DD`, or "" for none; `required={false}` marks it optional and offers Clear.
 */
export function DateField(props: Props) {
  const desk = useDesk();
  const optional = useOptional();
  if (desk) {
    return <DeskDateField {...props} />;
  }
  const { label, description, error, value, onChange, min, max, required, disabled, hideLabel } = props;
  return (
    <Input
      type="date"
      label={hideLabel ? undefined : required === false ? optional(label) : label}
      aria-label={hideLabel ? label : undefined}
      description={description}
      error={error}
      value={value}
      min={min}
      max={max}
      required={required === false ? undefined : required}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
