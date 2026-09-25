"use client";

import { Empty, LayerCard } from "@cloudflare/kumo";
import { CalendarBlankIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { todayHere } from "@/components/requests/request-form";
import { Failed } from "@/components/ui/failed";
import { MonthPicker, shiftMonth, thisMonth, type Month } from "@/components/ui/month-picker";
import { AsideCard, PageHeader, PageLayout, StatList } from "@/components/ui/page";
import { SkeletonLine } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";

interface PlannedDay {
  date: string;
  shift: { id: string; name: string; startTime: string; endTime: string } | null;
  holiday: string | null;
  weekend: boolean;
  away: string | null;
}

type Sort = "work" | "holiday" | "off" | "away" | "none";
type Group = "work" | "holiday" | "off" | "none";

const MONTHS_AHEAD = 3;
const MONTHS_BACK = 1;
const WEEK = 7;
const MONDAY_OFFSET = 6;

// Any Monday will do: the row only needs the seven weekday names in order.
const WEEK_START = new Date(Date.UTC(2024, 0, 1));

// The same order the timesheet judges a day in, so a planned day and a measured one agree.
function sortOf(day: PlannedDay): Sort {
  if (day.holiday) {
    return "holiday";
  }
  if (day.weekend) {
    return "off";
  }
  if (day.away === "LEAVE") {
    return "off";
  }
  if (day.away) {
    return "away";
  }
  return day.shift ? "work" : "none";
}

// A trip or a day from home is a working day, drawn apart so it is not mistaken for the office.
function groupOf(sort: Sort): Group {
  return sort === "away" ? "work" : sort;
}

/** Monday-first, because a shift week is read the way a calendar is printed. */
function leadingBlanks(firstDay: string): number {
  return (new Date(`${firstDay}T00:00:00Z`).getUTCDay() + MONDAY_OFFSET) % WEEK;
}

function order(at: Month): number {
  return at.year * 12 + at.month;
}

const CELL: Record<Sort, string> = {
  work: "bg-kumo-base",
  away: "bg-kumo-info-tint",
  holiday: "bg-kumo-warning-tint",
  off: "bg-kumo-tint text-kumo-subtle",
  none: "bg-kumo-base text-kumo-subtle",
};

function Swatch({ sort, label }: { sort: Sort; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <span aria-hidden className={cn("size-4 shrink-0 rounded ring-1 ring-kumo-hairline", CELL[sort])} />
      {label}
    </li>
  );
}

export default function MyShiftsPage() {
  const t = useTranslations("myShifts");
  const common = useTranslations("common");
  const format = useFormatter();
  const now = thisMonth();
  const earliest = shiftMonth(now, -MONTHS_BACK);
  const latest = shiftMonth(now, MONTHS_AHEAD);
  const [showing, setShowing] = useState<Month>(now);
  const [lit, setLit] = useState<Group | null>(null);

  const roster = useQuery({
    queryKey: ["me", "roster", showing.year, showing.month],
    queryFn: async () =>
      (await api.get<PlannedDay[]>(`/shifts/roster?year=${showing.year}&month=${showing.month}`)).data,
  });

  const days = roster.data ?? [];
  const today = todayHere();
  const count = (group: Group) => days.filter((one) => groupOf(sortOf(one)) === group).length;

  function move(next: Month): void {
    setShowing(order(next) < order(earliest) ? earliest : next);
    setLit(null);
  }

  function awayName(kind: string, short: boolean): string {
    if (kind === "BUSINESS_TRIP") {
      return short ? t("shortBUSINESS_TRIP") : t("awayBUSINESS_TRIP");
    }
    if (kind === "REMOTE_WORK") {
      return short ? t("shortREMOTE_WORK") : t("awayREMOTE_WORK");
    }
    return short ? t("shortLEAVE") : t("awayLEAVE");
  }

  function labelOf(day: PlannedDay, sort: Sort): { long: string; short: string } | null {
    if (day.holiday) {
      return { long: day.holiday, short: t("shortHoliday") };
    }
    if (sort === "off" && day.weekend) {
      return { long: t("weekend"), short: t("shortOff") };
    }
    if (day.away) {
      return { long: awayName(day.away, false), short: awayName(day.away, true) };
    }
    return day.shift ? null : { long: t("none"), short: common("empty") };
  }

  function stat(group: Group, label: string) {
    return { key: group, label, value: count(group), active: lit === group, onPick: () => setLit(lit === group ? null : group) };
  }

  const stats = roster.isSuccess
    ? [
        stat("work", t("countWork")),
        stat("holiday", t("countHoliday")),
        stat("off", t("countOff")),
        ...(count("none") > 0 ? [stat("none", t("countNone"))] : []),
      ]
    : [];

  return (
    <>
      <PageHeader title={t("title")} description={t("lead")} />
      <PageLayout
        aside={
          <AsideCard title={t("countsTitle")}>
            {roster.isPending ? (
              <div className="flex flex-col gap-2">
                <SkeletonLine minWidth={25} maxWidth={40} />
                <SkeletonLine minWidth={25} maxWidth={40} />
              </div>
            ) : (
              <StatList stats={stats} />
            )}
          </AsideCard>
        }
        extra={
          <AsideCard title={t("legend")}>
            <ul className="flex flex-col gap-2">
              <Swatch sort="work" label={t("legendWork")} />
              <Swatch sort="away" label={t("legendAway")} />
              <Swatch sort="holiday" label={t("legendHoliday")} />
              <Swatch sort="off" label={t("legendOff")} />
              <li className="flex items-center gap-2">
                <span aria-hidden className="size-4 shrink-0 rounded ring-2 ring-kumo-brand" />
                {t("legendToday")}
              </li>
            </ul>
          </AsideCard>
        }
      >
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <MonthPicker value={showing} onChange={move} max={latest} />
        </div>

        {roster.isError ? (
          <Failed onRetry={() => void roster.refetch()} />
        ) : roster.isPending ? (
          <LayerCard className="flex flex-col gap-3 p-4">
            {Array.from({ length: 5 }, (_, at) => (
              <SkeletonLine key={at} minWidth={33} maxWidth={100} />
            ))}
          </LayerCard>
        ) : days.length === 0 ? (
          <LayerCard className="p-0">
            <Empty
              icon={<CalendarBlankIcon size={40} className="text-kumo-inactive" />}
              title={t("empty")}
              description={t("emptyHint")}
              className="py-12"
            />
          </LayerCard>
        ) : (
          <LayerCard className="p-2 sm:p-3">
            <div aria-hidden className="grid grid-cols-7 gap-1 pb-1 text-center text-sm text-kumo-subtle">
              {Array.from({ length: WEEK }, (_, at) => (
                <span key={at}>{format.dateTime(new Date(WEEK_START.getTime() + at * 86_400_000), { weekday: "short" })}</span>
              ))}
            </div>
            <ol className="grid grid-cols-7 gap-1">
              {Array.from({ length: leadingBlanks(days[0].date) }, (_, at) => (
                <li key={`blank-${at}`} aria-hidden />
              ))}
              {days.map((day) => {
                const sort = sortOf(day);
                const label = labelOf(day, sort);
                const here = day.date.slice(0, 10) === today;
                return (
                  <li
                    key={day.date}
                    aria-current={here ? "date" : undefined}
                    className={cn(
                      "flex min-h-16 min-w-0 flex-col gap-0.5 rounded-md p-1 text-sm ring-1 ring-kumo-hairline sm:min-h-20 sm:p-1.5",
                      CELL[sort],
                      here && "ring-2 ring-kumo-brand",
                      lit !== null && lit !== groupOf(sort) && "opacity-40",
                    )}
                  >
                    <span className="font-medium text-kumo-default tabular-nums">{Number(day.date.slice(8, 10))}</span>
                    {label ? (
                      <>
                        <span className="line-clamp-2 max-sm:hidden">{label.long}</span>
                        <span className="truncate sm:hidden">{label.short}</span>
                      </>
                    ) : day.shift ? (
                      <>
                        <span className="truncate max-sm:hidden">{day.shift.name}</span>
                        <span className="text-kumo-subtle tabular-nums">
                          <span className="max-sm:hidden">
                            {day.shift.startTime}–{day.shift.endTime}
                          </span>
                          <span className="sm:hidden">{day.shift.startTime}</span>
                        </span>
                      </>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </LayerCard>
        )}
      </PageLayout>
    </>
  );
}
