"use client";

import { Button, ButtonGroup, Popover } from "@cloudflare/kumo";
import { CalendarBlankIcon, CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { todayIso } from "@/lib/format";

export interface Month {
  year: number;
  month: number;
}

export function thisMonth(): Month {
  const [year, month] = todayIso().split("-").map(Number);
  return { year, month };
}

export function shiftMonth(at: Month, by: number): Month {
  const index = at.year * 12 + (at.month - 1) + by;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** First and last calendar day of a month, as the api's YYYY-MM-DD. */
export function monthSpan(at: Month): { from: string; to: string } {
  const pad = (one: number) => String(one).padStart(2, "0");
  const last = new Date(Date.UTC(at.year, at.month, 0)).getUTCDate();
  return { from: `${at.year}-${pad(at.month)}-01`, to: `${at.year}-${pad(at.month)}-${pad(last)}` };
}

function order(at: Month): number {
  return at.year * 12 + at.month;
}

const MONTHS = Array.from({ length: 12 }, (_, at) => at + 1);

/** A month is one control, not two number boxes (KEHOACH 9.12): step with the
 *  arrows, or open the year to jump.
 */
export function MonthPicker({
  value,
  onChange,
  min,
  max,
}: {
  value: Month;
  onChange: (next: Month) => void;
  min?: Month;
  max?: Month;
}) {
  const t = useTranslations("common");
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(value.year);
  const earlier = shiftMonth(value, -1);
  const later = shiftMonth(value, 1);
  const blocked = (at: Month) =>
    (max !== undefined && order(at) > order(max)) || (min !== undefined && order(at) < order(min));
  const name = (at: Month, style: "long" | "short") =>
    format.dateTime(new Date(Date.UTC(at.year, at.month - 1, 15)), { month: style, ...(style === "long" ? { year: "numeric" } : {}) });

  return (
    <ButtonGroup aria-label={t("month")}>
      <Button
        variant="secondary"
        shape="square"
        icon={CaretLeftIcon}
        aria-label={t("earlier")}
        disabled={blocked(earlier)}
        onClick={() => onChange(earlier)}
      />
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setYear(value.year);
        }}
      >
        <Popover.Trigger
          render={
            <Button variant="secondary" icon={CalendarBlankIcon} className="min-w-44 justify-start tabular-nums">
              {name(value, "long")}
            </Button>
          }
        />
        <Popover.Content className="w-72">
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              shape="square"
              size="sm"
              icon={CaretLeftIcon}
              aria-label={t("earlier")}
              disabled={min !== undefined && year <= min.year}
              onClick={() => setYear(year - 1)}
            />
            <span className="font-semibold tabular-nums">{year}</span>
            <Button
              variant="ghost"
              shape="square"
              size="sm"
              icon={CaretRightIcon}
              aria-label={t("later")}
              disabled={max !== undefined && year >= max.year}
              onClick={() => setYear(year + 1)}
            />
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1">
            {MONTHS.map((month) => {
              const at = { year, month };
              const picked = year === value.year && month === value.month;
              return (
                <Button
                  key={month}
                  variant={picked ? "primary" : "ghost"}
                  size="sm"
                  disabled={blocked(at)}
                  aria-pressed={picked}
                  onClick={() => {
                    onChange(at);
                    setOpen(false);
                  }}
                >
                  {name(at, "short")}
                </Button>
              );
            })}
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2 w-full"
            disabled={blocked(thisMonth())}
            onClick={() => {
              onChange(thisMonth());
              setOpen(false);
            }}
          >
            {t("thisMonth")}
          </Button>
        </Popover.Content>
      </Popover>
      <Button
        variant="secondary"
        shape="square"
        icon={CaretRightIcon}
        aria-label={t("later")}
        disabled={blocked(later)}
        onClick={() => onChange(later)}
      />
    </ButtonGroup>
  );
}
