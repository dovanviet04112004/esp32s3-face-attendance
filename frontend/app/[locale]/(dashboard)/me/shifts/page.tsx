"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { Empty, Failed } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";

interface PlannedDay {
  date: string;
  shift: { id: string; name: string; startTime: string; endTime: string } | null;
  holiday: string | null;
  weekend: boolean;
  away: string | null;
}

const MONTHS_AHEAD = 3;
const MONTHS_BACK = 1;
const WEEK = 7;
const MONDAY_OFFSET = 6;

type Translate = ReturnType<typeof useTranslations<"myShifts">>;

// next-intl types its keys, so the kind is mapped rather than interpolated.
function awayLabel(t: Translate, kind: string): string {
  if (kind === "BUSINESS_TRIP") {
    return t("awayBUSINESS_TRIP");
  }
  return kind === "REMOTE_WORK" ? t("awayREMOTE_WORK") : t("awayLEAVE");
}

function monthKey(at: Date): { year: number; month: number } {
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1 };
}

/** Monday-first, because a shift week is read the way a calendar is printed. */
function leadingBlanks(firstDay: string): number {
  return (new Date(`${firstDay}T00:00:00Z`).getUTCDay() + MONDAY_OFFSET) % WEEK;
}

/** Any Monday will do: the row only needs the seven weekday names in order. */
const WEEK_START = new Date(Date.UTC(2024, 0, 1));

function weekdays(): Date[] {
  return Array.from(
    { length: WEEK },
    (unused, at) => new Date(WEEK_START.getTime() + at * 86_400_000),
  );
}

/** The reader's own today, since a roster cell is a calendar day not an instant. */
function todayHere(): string {
  const at = new Date();
  const pad = (one: number) => String(one).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export default function MyShiftsPage() {
  const t = useTranslations("myShifts");
  const common = useTranslations("common");
  const format = useFormatter();
  const [offset, setOffset] = useState(0);

  const now = new Date();
  const showing = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const { year, month } = monthKey(showing);

  const roster = useQuery({
    queryKey: ["me", "roster", year, month],
    queryFn: async () =>
      (await api.get<PlannedDay[]>(`/shifts/roster?year=${year}&month=${month}`)).data,
  });

  const days = roster.data ?? [];
  const today = todayHere();
  const working = days.filter((one) => one.shift && !one.holiday && !one.away).length;

  if (roster.isError) {
    return <Failed onRetry={() => void roster.refetch()} />;
  }

  return (
    <section className="mx-auto w-full max-w-(--width-read)">
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-(--color-muted)">{t("lead")}</p>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          aria-label={t("earlier")}
          disabled={offset <= -MONTHS_BACK}
          onClick={() => setOffset(offset - 1)}
          className="grid size-11 place-items-center rounded-lg border border-(--color-line) disabled:opacity-40"
        >
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <p className="min-w-40 text-center text-sm font-medium">
          {format.dateTime(showing, { year: "numeric", month: "long" })}
        </p>
        <button
          type="button"
          aria-label={t("later")}
          disabled={offset >= MONTHS_AHEAD}
          onClick={() => setOffset(offset + 1)}
          className="grid size-11 place-items-center rounded-lg border border-(--color-line) disabled:opacity-40"
        >
          <ChevronRight className="size-4" aria-hidden />
        </button>
        {roster.isSuccess ? (
          <p className="ml-auto text-sm text-(--color-muted)">{t("working", { count: working })}</p>
        ) : null}
      </div>

      {roster.isPending ? <Skeleton className="mt-4 h-72 w-full" /> : null}

      {roster.isSuccess && days.length === 0 ? (
        <div className="mt-4">
          <Empty title={common("noData")} />
        </div>
      ) : null}

      {roster.isSuccess && days.length > 0 ? (
        <>
          <div
            aria-hidden
            className="mt-4 grid grid-cols-7 gap-1 text-center text-[11px] text-(--color-muted)"
          >
            {weekdays().map((one) => (
              <span key={one.toISOString()}>
                {format.dateTime(one, { weekday: "short" })}
              </span>
            ))}
          </div>
          <ol className="mt-1 grid grid-cols-7 gap-1">
            {Array.from({ length: leadingBlanks(days[0].date) }, (unused, at) => (
              <li key={`blank-${at}`} aria-hidden />
            ))}
            {days.map((day) => {
              const off = day.holiday !== null || day.away !== null;
              const here = day.date.slice(0, 10) === today;
              return (
                <li
                  key={day.date}
                  aria-current={here ? "date" : undefined}
                  className={[
                    "min-h-20 rounded-lg border p-1 text-[11px] sm:p-1.5 sm:text-xs",
                    here ? "ring-2 ring-(--color-accent)" : "",
                    off
                      ? "border-(--color-warn) bg-(--color-warn)/10"
                      : day.weekend
                        ? "border-(--color-line) bg-(--color-ground)"
                        : "border-(--color-line) bg-(--color-surface)",
                  ].join(" ")}
                >
                  <p className="font-medium tabular-nums">{Number(day.date.slice(-2))}</p>
                  {day.holiday ? (
                    <p className="mt-1 line-clamp-2 text-(--color-warn)">{day.holiday}</p>
                  ) : day.away ? (
                    <p className="mt-1 line-clamp-2 text-(--color-warn)">{awayLabel(t, day.away)}</p>
                  ) : day.shift ? (
                    <>
                      <p className="mt-1 truncate max-sm:hidden">{day.shift.name}</p>
                      <p className="text-(--color-muted) tabular-nums">
                        <span className="max-sm:hidden">
                          {day.shift.startTime}–{day.shift.endTime}
                        </span>
                        <span className="sm:hidden">{day.shift.startTime}</span>
                      </p>
                    </>
                  ) : (
                    <p className="mt-1 text-(--color-muted)">{t("none")}</p>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
    </section>
  );
}
