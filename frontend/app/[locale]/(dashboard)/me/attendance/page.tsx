"use client";

import { Empty, LayerCard, LayerDialog, LinkButton } from "@cloudflare/kumo";
import { ClockCounterClockwiseIcon, UserCircleIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Suspense, useMemo, useState } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { MonthPicker, monthSpan, thisMonth, type Month } from "@/components/ui/month-picker";
import { AsideCard, Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill } from "@/components/ui/pill";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { atClock, clockOf, dayOf, dayOnly, dayWindow, todayIso } from "@/lib/format";
import { useUrlState } from "@/lib/url-state";

const kPunchPage = 200;
const kMaxPages = 10;
const kMinuteMs = 60_000;
const kDeviceTake = 200;
const MONTH = /^(\d{4})-(\d{2})$/;

interface Punch {
  id: string;
  deviceId: string;
  ts: string;
  direction: "IN" | "OUT";
  capturedOffline: boolean;
  clockUnsynced: boolean;
  questionableTime?: boolean;
}

interface PlannedDay {
  date: string;
  shift: { id: string; name: string; startTime: string; endTime: string; graceMinutes?: number } | null;
  holiday: string | null;
  weekend: boolean;
  away: string | null;
}

interface MonthTally {
  workedDays: number;
  lateCount: number;
  missingPunchDays: number;
  absentDays?: number;
}

type Mark = "late" | "missing" | "none" | "ok" | "off" | "ahead";

interface Day {
  date: string;
  plan: PlannedDay | undefined;
  punches: Punch[];
  lateMinutes: number;
  mark: Mark;
}

function monthOf(raw: string): Month {
  const found = MONTH.exec(raw);
  return found ? { year: Number(found[1]), month: Number(found[2]) } : thisMonth();
}

function monthKey(at: Month): string {
  return `${at.year}-${String(at.month).padStart(2, "0")}`;
}

/** Minutes past the shift's start plus its grace; zero or less is on time. */
function lateBy(day: string, shift: NonNullable<PlannedDay["shift"]>, first: Punch): number {
  const start = atClock(day, shift.startTime);
  return Math.floor((new Date(first.ts).getTime() - start.getTime()) / kMinuteMs) - (shift.graceMinutes ?? 0);
}

function markOf(date: string, plan: PlannedDay | undefined, punches: Punch[], late: number, today: string): Mark {
  if (date > today) {
    return "ahead";
  }
  const working = plan?.shift !== null && plan?.shift !== undefined && !plan.weekend && !plan.holiday && !plan.away;
  if (punches.length === 0) {
    return working && date < today ? "none" : "off";
  }
  if (punches.length === 1 && date < today) {
    return "missing";
  }
  return late > 0 ? "late" : "ok";
}

function MyAttendance() {
  const locale = useLocale();
  const t = useTranslations("me");
  const a = useTranslations("attendance");
  const shifts = useTranslations("myShifts");
  const nav = useTranslations("nav");
  const common = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const { employeeId, role } = useSession();
  const [url, setUrl] = useUrlState({ month: "" });
  const [open, setOpen] = useState<Day | null>(null);
  const month = monthOf(url.month);
  const span = monthSpan(month);
  const today = todayIso();

  const roster = useQuery({
    queryKey: ["me", "roster", month.year, month.month],
    enabled: employeeId !== null,
    queryFn: async () => (await api.get<PlannedDay[]>(`/shifts/roster?year=${month.year}&month=${month.month}`)).data,
  });

  const punches = useQuery({
    queryKey: ["attendance", "mine", employeeId, "month", monthKey(month)],
    enabled: employeeId !== null,
    queryFn: async () => {
      const from = dayWindow(span.from).from;
      const to = dayWindow(span.to).to;
      const all: Punch[] = [];
      let cursor = "";
      for (let page = 0; page < kMaxPages; page += 1) {
        const query = new URLSearchParams({
          employeeId: String(employeeId),
          from: from.toISOString(),
          to: to.toISOString(),
          take: String(kPunchPage),
          ...(cursor ? { cursor } : {}),
        });
        const held = (await api.get<{ rows: Punch[]; next: string | null }>(`/attendance?${query.toString()}`)).data;
        all.push(...held.rows);
        if (!held.next) {
          break;
        }
        cursor = held.next;
      }
      return all;
    },
  });

  // Until the month roll-up exists on this deployment, the days below are counted here instead.
  const tally = useQuery({
    queryKey: ["timesheet", "mine", monthKey(month)],
    enabled: employeeId !== null,
    retry: false,
    queryFn: async () => {
      try {
        return (await api.get<MonthTally>(`/timesheet/mine?month=${monthKey(month)}`)).data;
      } catch (fell: unknown) {
        if (isAxiosError(fell) && fell.response?.status === 404) {
          return null;
        }
        throw fell;
      }
    },
  });

  // Kiosk names come from a list only the fleet's owner reads; everyone else sees none rather than an id.
  const devices = useQuery({
    queryKey: ["devices", "names"],
    enabled: role === "ADMIN",
    queryFn: async () => (await api.get<{ rows: { id: string; name: string | null }[] }>(`/devices?take=${kDeviceTake}`)).data.rows,
  });
  const kioskName = new Map((devices.data ?? []).map((one) => [one.id, one.name ?? one.id]));

  const days = useMemo<Day[]>(() => {
    const byDay = new Map<string, Punch[]>();
    for (const one of punches.data ?? []) {
      const key = dayOf(one.ts);
      byDay.set(key, [...(byDay.get(key) ?? []), one]);
    }
    const plans = new Map((roster.data ?? []).map((one) => [one.date.slice(0, 10), one]));
    const last = Number(span.to.slice(8, 10));
    return Array.from({ length: last }, (_, at) => {
      const date = `${span.from.slice(0, 8)}${String(at + 1).padStart(2, "0")}`;
      const seen = (byDay.get(date) ?? []).sort((left, right) => left.ts.localeCompare(right.ts));
      const plan = plans.get(date);
      const late = plan?.shift && seen[0] ? lateBy(date, plan.shift, seen[0]) : 0;
      return { date, plan, punches: seen, lateMinutes: late, mark: markOf(date, plan, seen, late, today) };
    }).reverse();
  }, [punches.data, roster.data, span.from, span.to, today]);

  const counted = {
    workedDays: days.filter((one) => one.punches.length > 0).length,
    lateCount: days.filter((one) => one.mark === "late").length,
    missingPunchDays: days.filter((one) => one.mark === "missing").length,
    absentDays: days.filter((one) => one.mark === "none").length,
  };
  const totals = tally.data ?? counted;

  const clock = (iso: string) => format.dateTime(new Date(iso), { hour: "2-digit", minute: "2-digit" });
  const planWords = (plan: PlannedDay | undefined) => {
    if (plan?.holiday) {
      return `${t("holidayToday")}: ${plan.holiday}`;
    }
    if (plan?.away === "BUSINESS_TRIP" || plan?.away === "REMOTE_WORK" || plan?.away === "LEAVE") {
      return shifts(`away${plan.away}`);
    }
    if (plan?.weekend) {
      return shifts("weekend");
    }
    return plan?.shift ? `${clockOf(plan.shift.startTime, locale)}–${clockOf(plan.shift.endTime, locale)}` : shifts("none");
  };
  const fix = (date: string) => router.push(`/me/requests?new=ATTENDANCE_FIX&date=${date}`);
  const fixable = (day: Day) => day.date < today;

  const MARK: Record<Mark, { tone: "waiting" | "bad" | "good" | "idle"; label: (day: Day) => string } | null> = {
    late: { tone: "waiting", label: (day) => t("attLate", { minutes: day.lateMinutes }) },
    missing: { tone: "bad", label: () => t("attMissing") },
    none: { tone: "bad", label: () => t("attNoPunch") },
    ok: { tone: "good", label: () => t("attOnTime") },
    off: null,
    ahead: null,
  };

  const columns: Column<Day>[] = [
    {
      id: "day",
      header: t("attDay"),
      cell: (day) => (
        <span className="whitespace-nowrap tabular-nums">{format.dateTime(dayOnly(day.date), { weekday: "short", day: "2-digit", month: "2-digit" })}</span>
      ),
    },
    { id: "shift", header: t("attShift"), priority: 2, truncate: true, cell: (day) => planWords(day.plan) },
    {
      id: "punches",
      header: t("attPunches"),
      cell: (day) =>
        day.punches.length === 0 ? (
          common("empty")
        ) : (
          <span className="whitespace-nowrap tabular-nums">
            {day.punches.length === 1
              ? clock(day.punches[0]?.ts ?? "")
              : `${clock(day.punches[0]?.ts ?? "")} → ${clock(day.punches[day.punches.length - 1]?.ts ?? "")}`}
          </span>
        ),
    },
    {
      id: "mark",
      header: t("attStatus"),
      cell: (day) => {
        const mark = MARK[day.mark];
        return mark ? <StatePill tone={mark.tone}>{mark.label(day)}</StatePill> : null;
      },
    },
  ];

  if (employeeId === null) {
    return (
      <>
        <PageHeader title={nav("myAttendance")} />
        <LayerCard className="p-0">
          <Empty icon={<UserCircleIcon size={40} className="text-kumo-inactive" />} title={t("noProfile")} className="py-12" />
        </LayerCard>
      </>
    );
  }

  return (
    <>
      <PageHeader title={nav("myAttendance")} description={t("attLead")} />
      <PageLayout
        aside={
          <AsideCard title={t("attTotals")}>
            <Facts
              rows={[
                [t("attWorked"), totals.workedDays],
                [t("attLateCount"), totals.lateCount],
                [t("attMissingDays"), totals.missingPunchDays],
                ...(totals.absentDays === undefined ? [] : [[t("attAbsentDays"), totals.absentDays] as [string, number]]),
              ]}
            />
            <LinkButton
              href="/me/requests?new=ATTENDANCE_FIX"
              variant="secondary"
              icon={ClockCounterClockwiseIcon}
              className="mt-3 w-full justify-start"
            >
              {t("fixAsk")}
            </LinkButton>
          </AsideCard>
        }
      >
        <div data-toolbar="" className="mb-4">
          <MonthPicker value={month} max={thisMonth()} onChange={(next) => setUrl({ month: monthKey(next) === monthKey(thisMonth()) ? "" : monthKey(next) })} />
        </div>
        <DataTable
          id="my-attendance-days"
          columns={columns}
          rows={punches.isPending || roster.isPending ? undefined : days}
          keyOf={(day) => day.date}
          pending={punches.isPending || roster.isPending}
          failed={punches.isError || roster.isError}
          onRetry={() => {
            void punches.refetch();
            void roster.refetch();
          }}
          cardLead="day"
          cardTrailing="mark"
          onRowClick={setOpen}
          rowActions={(day) =>
            fixable(day)
              ? [{ key: "fix", label: t("fixThisDay"), icon: ClockCounterClockwiseIcon, onSelect: () => fix(day.date) }]
              : []
          }
        />
      </PageLayout>

      <LayerDialog.Root open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{open ? format.dateTime(dayOnly(open.date), { weekday: "long", day: "numeric", month: "long" }) : ""}</LayerDialog.Title>
          <LayerDialog.Description>{open ? planWords(open.plan) : ""}</LayerDialog.Description>
          <LayerDialog.Body>
            {open && open.punches.length === 0 ? (
              <p className="text-kumo-subtle">{t("attNoPunches")}</p>
            ) : (
              <ul className="-my-1 flex flex-col">
                {(open?.punches ?? []).map((one) => (
                  <li key={one.id} className="flex items-center justify-between gap-3 border-b border-kumo-hairline py-2 last:border-0">
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium tabular-nums">
                        {clock(one.ts)} · {a(`direction${one.direction}`)}
                      </span>
                      {role === "ADMIN" ? (
                        <span className="truncate text-sm text-kumo-subtle">{kioskName.get(one.deviceId) ?? common("empty")}</span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 flex-wrap justify-end gap-1.5">
                      {one.questionableTime ? <StatePill tone="bad">{a("flagQuestionable")}</StatePill> : null}
                      {one.clockUnsynced ? <StatePill tone="waiting">{a("flagClock")}</StatePill> : null}
                      {one.capturedOffline ? <StatePill>{a("flagOffline")}</StatePill> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </LayerDialog.Body>
          {open && fixable(open) ? (
            <LayerDialog.Actions dismissLabel={common("close")}>
              <LayerDialog.Actions.Primary onClick={() => fix(open.date)}>{t("fixThisDay")}</LayerDialog.Actions.Primary>
            </LayerDialog.Actions>
          ) : null}
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}

// The month rides on the query string, which the prerender does not have.
export default function MyAttendancePage() {
  return (
    <Suspense>
      <MyAttendance />
    </Suspense>
  );
}
