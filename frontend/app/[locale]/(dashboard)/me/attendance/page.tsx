"use client";

import { Button, Empty, LayerCard, LayerDialog } from "@cloudflare/kumo";
import { CheckIcon, ClockCounterClockwiseIcon, UserCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Suspense, useEffect, useMemo, useState } from "react";

import type { Notice } from "@/components/notifications/kinds";
import { NOTICES_KEY, useNoticeWords, useReadSubject } from "@/components/notifications/notice-row";
import { RequestForm } from "@/components/requests/request-form";
import { DataTable, type Column } from "@/components/tables/data-table";
import { MonthPicker, monthKey, monthSpan, thisMonth, type Month } from "@/components/ui/month-picker";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { clockOf, dayOf, dayOnly, dayWindow, lateBy, todayIso } from "@/lib/format";
import { useUrlState } from "@/lib/url-state";

const kPunchPage = 200;
const kMaxPages = 10;
const kDeviceTake = 200;
const MONTH = /^(\d{4})-(\d{2})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

interface Punch {
  id: string;
  deviceId: string;
  ts: string;
  direction: "IN" | "OUT";
  capturedOffline: boolean;
  clockUnsynced: boolean;
  questionableTime?: boolean;
  review?: "PENDING" | "ACCEPTED" | "REJECTED" | null;
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

/** A day as the timesheet holds it, with whoever corrected it by hand (KEHOACH 9.8). */
interface Built {
  workedMinutes: number;
  adjustedByName: string | null;
  adjustReason: string | null;
  adjustedAt: string | null;
}

/** The work a deviating day holds for its own person (KEHOACH 9.21.4). */
interface DayWork {
  key: string;
  state: "OPEN" | "DONE" | "WITHDRAWN" | "EXPIRED" | "CLEARED";
  facts: Notice["facts"];
  resolvable: boolean;
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
  const cache = useQueryClient();
  const notify = useNotify();
  const say = useNoticeWords();
  const { employeeId, role } = useSession();
  const [url, setUrl] = useUrlState({ month: "", day: "" });
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [fixSeed, setFixSeed] = useState(0);
  const [fixing, setFixing] = useState(false);
  const [fixDate, setFixDate] = useState<string | undefined>(undefined);
  const [handOff, setHandOff] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  // A notice names a day, and the month around it is the one to show.
  const linkedDay = DAY.test(url.day) ? url.day : "";
  const month = monthOf(url.month || linkedDay.slice(0, 7));
  const span = monthSpan(month);
  const today = todayIso();

  // A notice's ?day= only opens the sheet, so closing it never waits for the router to drop the param.
  useEffect(() => {
    if (!linkedDay) {
      return;
    }
    setOpenDate(linkedDay);
    const linkedMonth = linkedDay.slice(0, 7);
    setUrl({ day: "", month: linkedMonth === monthKey(thisMonth()) ? "" : linkedMonth });
  }, [linkedDay, setUrl]);

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
      const late = plan?.shift && seen[0] ? lateBy(date, plan.shift, seen[0].ts) : 0;
      return { date, plan, punches: seen, lateMinutes: late, mark: markOf(date, plan, seen, late, today) };
    }).reverse();
  }, [punches.data, roster.data, span.from, span.to, today]);

  const open = openDate ? (days.find((one) => one.date === openDate) ?? null) : null;
  const openPast = open !== null && open.date < today;
  const workKey = open && employeeId !== null ? `attendance:${employeeId}:${open.date}` : "";
  useReadSubject("PERSON_DAY", open && employeeId !== null ? `${employeeId}:${open.date}` : null);

  const built = useQuery({
    queryKey: ["timesheet", "mine", "day", open?.date],
    enabled: openPast && employeeId !== null,
    queryFn: async () =>
      (await api.get<Built[]>(`/timesheet?from=${open?.date}&to=${open?.date}&employeeId=${employeeId}`)).data[0] ?? null,
  });

  const work = useQuery({
    queryKey: [...NOTICES_KEY, "items", workKey],
    enabled: openPast && workKey !== "",
    retry: false,
    queryFn: async () => {
      try {
        return (await api.get<DayWork>(`/notifications/items/${encodeURIComponent(workKey)}`)).data;
      } catch (fell: unknown) {
        if (isAxiosError(fell) && fell.response?.status === 404) {
          return null;
        }
        throw fell;
      }
    },
  });

  const letGo = useMutation({
    mutationFn: (key: string) => api.post(`/notifications/items/${encodeURIComponent(key)}/resolve`, { note: "" }),
    onSuccess: () => {
      notify.done(t("attLetGone"));
      void cache.invalidateQueries({ queryKey: NOTICES_KEY });
    },
    onError: notify.failed,
  });

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
  const fix = (date?: string) => {
    setFixDate(date);
    setFixSeed((held) => held + 1);
    setFixing(true);
  };
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
            <Button variant="secondary" icon={ClockCounterClockwiseIcon} className="mt-3 w-full justify-start" onClick={() => fix()}>
              {t("fixAsk")}
            </Button>
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
          onRowClick={(day) => setOpenDate(day.date)}
          rowActions={(day) =>
            fixable(day)
              ? [{ key: "fix", label: t("fixThisDay"), icon: ClockCounterClockwiseIcon, onSelect: () => fix(day.date) }]
              : []
          }
        />
      </PageLayout>

      <LayerDialog.Root
        open={open !== null && !leaving}
        onOpenChange={(next) => !next && setLeaving(true)}
        onOpenChangeComplete={(next) => {
          if (next) {
            return;
          }
          // The day stays drawn while its sheet slides away; only then does the form rise.
          setLeaving(false);
          setOpenDate(null);
          if (handOff) {
            fix(handOff);
            setHandOff(null);
          }
        }}
      >
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{open ? format.dateTime(dayOnly(open.date), { weekday: "long", day: "numeric", month: "long" }) : ""}</LayerDialog.Title>
          <LayerDialog.Description>{open ? planWords(open.plan) : ""}</LayerDialog.Description>
          <LayerDialog.Body>
            {built.data?.adjustedAt ? (
              <div className="mb-4 flex flex-col gap-2 border-b border-kumo-hairline pb-4">
                <p className="font-medium">
                  {t("attCorrected", {
                    who: built.data.adjustedByName ?? common("empty"),
                    time: format.dateTime(new Date(built.data.adjustedAt), "medium"),
                  })}
                </p>
                <p className="text-kumo-subtle">{t("attCorrectedMinutes", { minutes: built.data.workedMinutes })}</p>
                {built.data.adjustReason ? <p className="rounded-lg bg-kumo-tint p-3 break-words">{built.data.adjustReason}</p> : null}
              </div>
            ) : null}
            {work.data?.state === "OPEN" ? (
              <div className="mb-4 flex flex-col gap-2 border-b border-kumo-hairline pb-4">
                <p className="font-medium">{t("attOff")}</p>
                <ul className="flex flex-col gap-1">
                  {say.deviations(work.data.facts).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                {work.data.resolvable ? (
                  <Button
                    variant="secondary"
                    icon={CheckIcon}
                    className="self-start"
                    loading={letGo.isPending}
                    onClick={() => work.data && letGo.mutate(work.data.key)}
                  >
                    {t("attLetGo")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {work.data?.state === "DONE" ? <p className="mb-4 text-kumo-subtle">{t("attLetGone")}</p> : null}
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
                      {one.review === "PENDING" ? <StatePill tone="waiting">{a("flagHeld")}</StatePill> : null}
                      {one.review === "REJECTED" ? <StatePill tone="bad">{a("flagRejected")}</StatePill> : null}
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
              <LayerDialog.Actions.Primary
                onClick={() => {
                  setHandOff(open.date);
                  setLeaving(true);
                }}
              >
                {t("fixThisDay")}
              </LayerDialog.Actions.Primary>
            </LayerDialog.Actions>
          ) : null}
        </LayerDialog.Content>
      </LayerDialog.Root>

      <RequestForm key={fixSeed} open={fixing} onOpenChange={setFixing} kind="ATTENDANCE_FIX" date={fixDate} />
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
