"use client";

import { Button, Empty, LayerCard, Tabs } from "@cloudflare/kumo";
import { CalendarPlusIcon, CaretRightIcon, CheckCircleIcon, FileTextIcon, UserCircleIcon, XCircleIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useFormatter, useLocale, useNow, useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { StatePill as RequestPill, useRequestWords, type RequestRow } from "@/components/requests/request-card";
import { InboxPreview, useShortSpan } from "@/components/requests/inbox-preview";
import { RequestForm, todayHere } from "@/components/requests/request-form";
import { Failed } from "@/components/ui/failed";
import { PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill } from "@/components/ui/pill";
import { SkeletonLine } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { clockOf, dayOnly, days, money } from "@/lib/format";

interface Balance {
  leaveTypeId: string;
  name: string;
  year: number;
  entitled: number;
  carriedOver: number;
  taken: number;
  pending: number;
  remaining: number;
  bookedAfter: number;
}

interface Me {
  id: number;
  code: string;
  fullName: string;
  department: { id: string; name: string } | null;
}

interface PlannedDay {
  date: string;
  shift: { id: string; name: string; startTime: string; endTime: string; graceMinutes?: number } | null;
  holiday: string | null;
  weekend: boolean;
  away: string | null;
}

interface Punch {
  id: string;
  ts: string;
  direction: "IN" | "OUT";
}

interface PayslipRow {
  id: string;
  netPay: string;
  workedDays: string;
  period?: { year: number; month: number };
}

interface MonthTally {
  workedDays: number;
  lateCount: number;
  missingPunchDays: number;
}

interface ToRead {
  versionId: string;
  title: string;
  ackAt: string | null;
}

interface Person {
  id: number;
  code: string;
  fullName: string;
}

interface TeamToday {
  absent: Person[];
  onLeave: Person[];
  notPunched: Person[];
  totals: { absent: number; onLeave: number; notPunched: number };
}

type TeamBucket = keyof TeamToday["totals"];

const TEAM_BUCKETS: { key: TeamBucket; label: "teamAbsent" | "teamOnLeave" | "teamNotPunched" }[] = [
  { key: "absent", label: "teamAbsent" },
  { key: "onLeave", label: "teamOnLeave" },
  { key: "notPunched", label: "teamNotPunched" },
];

const kDayMs = 86_400_000;
const kMinuteMs = 60_000;
const kPunchesShown = 20;
const kRecentTake = 20;
const kDecidedShown = 3;
const kTeamShown = 6;
const kWeekDays = 7;
// A turn-down stays on the to-do list this long; the request list keeps it after that.
const kFreshDays = 7;

/** A section whose endpoint this deployment lacks answers null and hides, rather than failing. */
async function unlessMissing<T>(path: string): Promise<T | null> {
  try {
    return (await api.get<T>(path)).data;
  } catch (fell: unknown) {
    if (isAxiosError(fell) && fell.response?.status === 404) {
      return null;
    }
    throw fell;
  }
}

function dayAfter(day: string, by = 1): string {
  const at = dayOnly(day);
  at.setDate(at.getDate() + by);
  const pad = (one: number) => String(one).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Minutes past the shift's start plus its grace; zero or less is on time. */
function lateBy(day: string, shift: NonNullable<PlannedDay["shift"]>, firstPunch: string): number {
  const [hour, minute] = shift.startTime.split(":").map(Number);
  const start = dayOnly(day);
  start.setHours(hour, minute, 0, 0);
  return Math.floor((new Date(firstPunch).getTime() - start.getTime()) / kMinuteMs) - (shift.graceMinutes ?? 0);
}

function worksOn(day: PlannedDay | undefined): day is PlannedDay & { shift: NonNullable<PlannedDay["shift"]> } {
  return Boolean(day?.shift && !day.holiday && !day.away && !day.weekend);
}

// Kumo draws each line at a random width and pace, which the server render cannot match.

function SkeletonRows({ rows = 2 }: { rows?: number }) {
  return (
    <ul aria-hidden className="flex flex-col">
      {Array.from({ length: rows }, (_, at) => (
        <li key={at} className="flex min-h-12 items-center justify-between gap-4 border-b border-kumo-hairline px-4 last:border-0">
          <SkeletonLine minWidth={45} maxWidth={45} />
          <SkeletonLine minWidth={15} maxWidth={15} />
        </li>
      ))}
    </ul>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2.5 px-4 py-3.5 text-kumo-subtle">
      <CheckCircleIcon size={18} weight="fill" className="shrink-0 text-kumo-success" aria-hidden />
      {children}
    </p>
  );
}

function Pad({ children }: { children: ReactNode }) {
  return <div className="p-4">{children}</div>;
}

/** Card anatomy of both home pages: a title strip with one link at its right, rows in the body. */
function Card({ title, link, children }: { title: ReactNode; link?: { href: string; label: string }; children: ReactNode }) {
  return (
    <LayerCard>
      <LayerCard.Secondary className="justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 truncate">{title}</span>
        {link ? (
          <Link href={link.href} className="shrink-0 font-normal text-kumo-link hover:underline">
            {link.label}
          </Link>
        ) : null}
      </LayerCard.Secondary>
      <LayerCard.Primary className="gap-0 p-0 pr-0">{children}</LayerCard.Primary>
    </LayerCard>
  );
}

function RowLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <li className="border-b border-kumo-hairline last:border-0">
      <Link href={href} className="flex min-h-12 items-center gap-3 px-4 py-2.5 hover:bg-kumo-tint motion-press">
        {children}
        <CaretRightIcon size={14} className="shrink-0 text-kumo-subtle" aria-hidden />
      </Link>
    </li>
  );
}

function useRoster(year: number, month: number, enabled: boolean) {
  return useQuery({
    queryKey: ["me", "roster", year, month],
    enabled,
    queryFn: async () => (await api.get<PlannedDay[]>(`/shifts/roster?year=${year}&month=${month}`)).data,
  });
}

/** The roster of the next seven days, across a month's end when the week crosses one. */
function useWeek(today: string) {
  const last = dayAfter(today, kWeekDays - 1);
  const [year, month] = today.split("-").map(Number);
  const [lastYear, lastMonth] = last.split("-").map(Number);
  const first = useRoster(year, month, true);
  const second = useRoster(lastYear, lastMonth, lastMonth !== month);
  const pending = first.isPending || (lastMonth !== month && second.isPending);
  const failed = first.isError || second.isError;
  const all = [...(first.data ?? []), ...(lastMonth !== month ? (second.data ?? []) : [])];
  const byDay = new Map(all.map((one) => [one.date.slice(0, 10), one]));
  const week = Array.from({ length: kWeekDays }, (_, at) => {
    const day = dayAfter(today, at);
    return { day, plan: byDay.get(day) };
  });
  return { week, pending, failed, retry: () => void Promise.all([first.refetch(), second.refetch()]) };
}

/** What a planned day holds in one or two words, for a narrow cell. */
function usePlanShort(): (day: PlannedDay | undefined) => string | null {
  const t = useTranslations("me");
  return (day) => {
    if (!day) {
      return t("weekNone");
    }
    if (day.holiday) {
      return t("weekHoliday");
    }
    if (day.away === "LEAVE") {
      return t("weekLeave");
    }
    if (day.away === "BUSINESS_TRIP") {
      return t("weekTrip");
    }
    if (day.away === "REMOTE_WORK") {
      return t("weekRemote");
    }
    if (day.weekend || !day.shift) {
      return t("weekOff");
    }
    return null;
  };
}

function TodayCard({ employeeId, week }: { employeeId: number; week: ReturnType<typeof useWeek> }) {
  const locale = useLocale();
  const t = useTranslations("me");
  const a = useTranslations("attendance");
  const shifts = useTranslations("myShifts");
  const format = useFormatter();
  const today = todayHere();
  const tomorrow = dayAfter(today);

  const punches = useQuery({
    queryKey: ["attendance", "mine", employeeId, "day", today],
    queryFn: async () => {
      const from = dayOnly(today).toISOString();
      const to = dayOnly(tomorrow).toISOString();
      const query = new URLSearchParams({ employeeId: String(employeeId), from, to, take: String(kPunchesShown) });
      const rows = (await api.get<{ rows: Punch[] }>(`/attendance?${query.toString()}`)).data.rows;
      return [...rows].sort((left, right) => left.ts.localeCompare(right.ts));
    },
  });

  const planned = week.week[0]?.plan;
  const first = punches.data?.[0];
  const late = worksOn(planned) && first ? lateBy(today, planned.shift, first.ts) : null;
  const off = (() => {
    if (!planned) {
      return shifts("none");
    }
    if (planned.holiday) {
      return `${t("holidayToday")}: ${planned.holiday}`;
    }
    if (planned.away === "BUSINESS_TRIP" || planned.away === "REMOTE_WORK" || planned.away === "LEAVE") {
      return shifts(`away${planned.away}`);
    }
    return planned.weekend ? t("weekendToday") : shifts("none");
  })();
  const pill =
    punches.isPending || week.pending ? null : late !== null ? (
      late > 0 ? (
        <StatePill tone="waiting">{t("todayLate", { minutes: late })}</StatePill>
      ) : (
        <StatePill tone="good">{t("todayOnTime")}</StatePill>
      )
    ) : worksOn(planned) && punches.data?.length === 0 ? (
      <StatePill tone="idle">{t("noPunchYet")}</StatePill>
    ) : null;

  return (
    <Card
      title={
        <span className="truncate">
          {t("todayTitle")}
          <span className="font-normal text-kumo-subtle"> · {format.dateTime(dayOnly(today), { weekday: "long", day: "numeric", month: "numeric" })}</span>
        </span>
      }
      link={{ href: "/me/attendance", label: t("allPunches") }}
    >
      {week.failed ? (
        <Pad>
          <Failed onRetry={week.retry} />
        </Pad>
      ) : (
        <ul className="flex flex-col">
          <li className="flex min-h-14 items-center gap-3 border-b border-kumo-hairline px-4 py-3">
            <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
              {week.pending ? (
                <span className="w-40">
                  <SkeletonLine minWidth={100} maxWidth={100} />
                </span>
              ) : worksOn(planned) ? (
                <>
                  <span className="text-xl font-semibold tabular-nums">
                    {clockOf(planned.shift.startTime, locale)}–{clockOf(planned.shift.endTime, locale)}
                  </span>
                  <span className="text-kumo-subtle">{planned.shift.name}</span>
                </>
              ) : (
                <span className="text-lg font-medium">{off}</span>
              )}
            </span>
            {pill}
          </li>
          <li className="flex min-h-12 items-center gap-3 px-4 py-2.5">
            <span className="shrink-0 text-kumo-subtle">{t("todayPunches")}</span>
            {punches.isPending ? (
              <span className="w-24">
                <SkeletonLine minWidth={100} maxWidth={100} />
              </span>
            ) : punches.isError ? (
              <button type="button" onClick={() => void punches.refetch()} className="text-kumo-link hover:underline">
                {t("punchesFailed")}
              </button>
            ) : punches.data.length === 0 ? (
              <span className="text-kumo-subtle">{t("noPunchToday")}</span>
            ) : (
              <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
                {punches.data.map((one) => (
                  <span key={one.id} className="flex items-baseline gap-1 motion-enter">
                    <span className="font-medium tabular-nums">{format.dateTime(new Date(one.ts), "clock")}</span>
                    <span className="text-sm text-kumo-subtle">{a(`direction${one.direction}`)}</span>
                  </span>
                ))}
              </span>
            )}
          </li>
        </ul>
      )}
    </Card>
  );
}

function WeekCard({ week }: { week: ReturnType<typeof useWeek> }) {
  const locale = useLocale();
  const t = useTranslations("me");
  const nav = useTranslations("nav");
  const format = useFormatter();
  const short = usePlanShort();
  const today = todayHere();
  return (
    <Card title={t("weekTitle")} link={{ href: "/me/shifts", label: nav("myShifts") }}>
      {week.failed ? (
        <Pad>
          <Failed onRetry={week.retry} />
        </Pad>
      ) : (
        <ol className="grid grid-cols-7 divide-x divide-kumo-hairline">
          {week.week.map(({ day, plan }) => {
            const word = week.pending ? null : short(plan);
            const works = !week.pending && worksOn(plan);
            return (
              <li
                key={day}
                aria-current={day === today ? "date" : undefined}
                title={works && plan?.shift ? plan.shift.name : (plan?.holiday ?? undefined)}
                className={cn("flex min-w-0 flex-col items-center gap-0.5 px-0.5 py-2.5 text-center", day === today && "bg-kumo-tint")}
              >
                <span className={cn("text-sm", day === today ? "font-semibold text-kumo-default" : "text-kumo-subtle")}>
                  {format.dateTime(dayOnly(day), { weekday: "short" })}
                </span>
                <span className="text-sm text-kumo-subtle tabular-nums">{format.dateTime(dayOnly(day), { day: "numeric", month: "numeric" })}</span>
                {week.pending ? (
                  <span className="mt-1 flex w-8 flex-col gap-1.5 py-1">
                    <SkeletonLine minWidth={100} maxWidth={100} />
                    <SkeletonLine minWidth={100} maxWidth={100} />
                  </span>
                ) : works && plan?.shift ? (
                  <span className="mt-1 flex flex-col text-sm leading-tight font-medium tabular-nums">
                    <span>{clockOf(plan.shift.startTime, locale)}</span>
                    <span className="text-kumo-subtle">{clockOf(plan.shift.endTime, locale)}</span>
                  </span>
                ) : (
                  <span className="mt-1 text-sm leading-tight text-kumo-subtle">{word}</span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

function TeamCard() {
  const t = useTranslations("me");
  const format = useFormatter();
  const [picked, setPicked] = useState<TeamBucket | null>(null);
  const team = useQuery({
    queryKey: ["reports", "team-today"],
    queryFn: () => unlessMissing<TeamToday>("/reports/team-today"),
  });
  const held = team.data;
  if (held === null) {
    return null;
  }
  const day = todayHere();
  const bucket = picked ?? TEAM_BUCKETS.find(({ key }) => (held?.totals[key] ?? 0) > 0)?.key ?? "absent";
  const people = held?.[bucket] ?? [];
  const total = held?.totals[bucket] ?? 0;
  const allIn = held !== undefined && TEAM_BUCKETS.every(({ key }) => held.totals[key] === 0);
  return (
    <Card
      title={t("teamTitle")}
      link={bucket === "onLeave" && total > 0 ? { href: `/leave?kind=LEAVE&state=APPROVED&from=${day}&to=${day}`, label: t("teamLeaveAll", { count: total }) } : undefined}
    >
      {team.isError ? (
        <Pad>
          <Failed onRetry={() => void team.refetch()} />
        </Pad>
      ) : held === undefined ? (
        <SkeletonRows rows={3} />
      ) : allIn ? (
        <Quiet>{t("teamAllIn")}</Quiet>
      ) : (
        <>
          <div className="@container border-b border-kumo-hairline px-3 py-2.5">
            <div className="hidden @md:block">
              <Tabs
                variant="segmented"
                value={bucket}
                onValueChange={(next) => setPicked(next as TeamBucket)}
                tabs={TEAM_BUCKETS.map(({ key, label }) => ({
                  value: key,
                  label: (
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                      {t(label)}
                      <span className="text-kumo-subtle tabular-nums">{format.number(held.totals[key])}</span>
                    </span>
                  ),
                }))}
              />
            </div>
            <div role="tablist" className="grid grid-cols-3 gap-1 rounded-lg bg-kumo-recessed p-1 @md:hidden">
              {TEAM_BUCKETS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={key === bucket}
                  onClick={() => setPicked(key)}
                  className={cn(
                    "flex min-h-11 min-w-0 flex-col items-center justify-center rounded-md px-1 leading-tight",
                    key === bucket
                      ? "bg-kumo-base font-medium text-kumo-default shadow-sm ring ring-kumo-line"
                      : "text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default",
                  )}
                >
                  <span className="max-w-full truncate text-sm">{t(label)}</span>
                  <span className="tabular-nums">{format.number(held.totals[key])}</span>
                </button>
              ))}
            </div>
          </div>
          {people.length === 0 ? (
            <Quiet>{t("teamNone")}</Quiet>
          ) : (
            <ul className="flex flex-col motion-enter" key={bucket}>
              {people.slice(0, kTeamShown).map((one) => (
                <RowLink key={one.id} href={`/employees/${one.id}`}>
                  <span className="min-w-0 flex-1 truncate">{one.fullName}</span>
                  <span className="shrink-0 font-mono text-sm text-kumo-subtle">{one.code}</span>
                </RowLink>
              ))}
              {total > Math.min(people.length, kTeamShown) ? (
                <li className="px-4 py-2.5 text-sm text-kumo-subtle tabular-nums">
                  {t("teamMore", { count: total - Math.min(people.length, kTeamShown) })}
                </li>
              ) : null}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

function RequestLine({ row }: { row: RequestRow }) {
  const r = useTranslations("requests");
  const words = useRequestWords();
  const shortSpan = useShortSpan();
  return (
    <RowLink href={`/me/requests?open=${row.id}`}>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">
          <span className="font-medium">{r(`kind${row.kind}`)}</span>
          {row.leaveType ? <span className="text-kumo-subtle"> · {row.leaveType.name}</span> : null}
        </span>
        <span className="truncate text-sm text-kumo-subtle tabular-nums">
          {shortSpan(row)} · {words.extent(row)}
        </span>
      </span>
      <span className="shrink-0">
        <RequestPill state={row.state} />
      </span>
    </RowLink>
  );
}

/** Everyone's own home, the manager's with their inbox and team second (KEHOACH 9.10). */
export default function MyPage() {
  const t = useTranslations("me");
  const r = useTranslations("requests");
  const pay = useTranslations("payroll");
  const common = useTranslations("common");
  const nav = useTranslations("nav");
  const format = useFormatter();
  const locale = useLocale();
  const now = useNow();
  const words = useRequestWords();
  const shortSpan = useShortSpan();
  const { employeeId, role } = useSession();
  const today = todayHere();
  const week = useWeek(today);
  const [seed, setSeed] = useState(0);
  const [filing, setFiling] = useState(false);
  const has = employeeId !== null;
  const monthKey = today.slice(0, 7);
  const monthName = format.dateTime(dayOnly(today), { month: "numeric", year: "numeric" });

  const me = useQuery({
    queryKey: ["employees", employeeId],
    enabled: has,
    queryFn: async () => (await api.get<Me>(`/employees/${employeeId}`)).data,
  });
  const tally = useQuery({
    queryKey: ["timesheet", "mine", monthKey],
    enabled: has,
    queryFn: () => unlessMissing<MonthTally>(`/timesheet/mine?month=${monthKey}`),
  });
  const balances = useQuery({
    queryKey: ["leave-balances", "mine", today],
    enabled: has,
    queryFn: async () => (await api.get<Balance[]>(`/leave-balances?asOf=${today}`)).data,
  });
  const pending = useQuery({
    queryKey: ["requests", "mine", employeeId, "pending"],
    enabled: has,
    queryFn: async () =>
      (await api.get<{ rows: RequestRow[]; total: number }>(`/requests?employeeId=${employeeId}&state=PENDING`)).data,
  });
  const recent = useQuery({
    queryKey: ["requests", "mine", employeeId, "recent"],
    enabled: has,
    queryFn: async () =>
      (await api.get<{ rows: RequestRow[] }>(`/requests?employeeId=${employeeId}&take=${kRecentTake}`)).data.rows,
  });
  const documents = useQuery({
    queryKey: ["me", "documents"],
    enabled: has,
    queryFn: () => unlessMissing<ToRead[]>("/me/documents"),
  });
  const latest = useQuery({
    queryKey: ["payslips", "mine", employeeId, "latest"],
    enabled: has,
    queryFn: async () =>
      (await api.get<{ rows: PayslipRow[] }>(`/payslips?employeeId=${employeeId}&take=1`)).data.rows[0] ?? null,
  });

  function askLeave(): void {
    setSeed((held) => held + 1);
    setFiling(true);
  }

  if (!has) {
    return (
      <>
        <PageHeader title={t("title")} />
        <LayerCard className="p-0">
          <Empty icon={<UserCircleIcon size={40} className="text-kumo-inactive" />} title={t("noProfile")} className="py-12" />
        </LayerCard>
      </>
    );
  }

  const decidedAt = (row: RequestRow) => new Date(row.decidedAt ?? row.createdAt).getTime();
  const decided = (recent.data ?? [])
    .filter((row) => row.state === "APPROVED" || row.state === "REJECTED")
    .sort((left, right) => decidedAt(right) - decidedAt(left));
  const turnedDown = decided.filter((row) => row.state === "REJECTED" && now.getTime() - decidedAt(row) < kFreshDays * kDayMs);
  const unsigned = (documents.data ?? []).filter((one) => one.ackAt === null);
  const mine = pending.data?.rows ?? [];
  const lines = [...mine, ...decided.slice(0, kDecidedShown)];
  const year = today.slice(0, 4);
  const monthHref = `/me/attendance?month=${monthKey}`;
  const figures = [
    { key: "monthWorked", value: tally.data?.workedDays, unit: (n: number) => days(n, locale), warn: false },
    { key: "monthLate", value: tally.data?.lateCount, unit: (n: number) => t("times", { count: n }), warn: true },
    { key: "monthMissing", value: tally.data?.missingPunchDays, unit: (n: number) => days(n, locale), warn: true },
  ] as const;

  const main = (
    <div className="flex flex-col gap-4">
      <TodayCard employeeId={employeeId} week={week} />

      {role === "MANAGER" ? (
        <>
          <InboxPreview />
          <TeamCard />
        </>
      ) : null}

      {unsigned.length + turnedDown.length > 0 ? (
        <Card title={t("todoTitle")}>
          <ul className="flex flex-col">
            {unsigned.map((one) => (
              <RowLink key={one.versionId} href="/me/documents">
                <FileTextIcon size={18} className="shrink-0 text-kumo-subtle" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{t("todoSign", { title: one.title })}</span>
              </RowLink>
            ))}
            {turnedDown.map((row) => (
              <RowLink key={row.id} href={`/me/requests?open=${row.id}`}>
                <XCircleIcon size={18} className="shrink-0 text-kumo-danger" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{t("todoTurnedDown", { what: words.kind(row), span: shortSpan(row) })}</span>
              </RowLink>
            ))}
          </ul>
        </Card>
      ) : null}

      <WeekCard week={week} />

      <Card title={r("mine")} link={{ href: "/me/requests", label: common("seeAll") }}>
        {pending.isPending || recent.isPending ? (
          <SkeletonRows rows={3} />
        ) : pending.isError || recent.isError ? (
          <Pad>
            <Failed
              onRetry={() => {
                void pending.refetch();
                void recent.refetch();
              }}
            />
          </Pad>
        ) : lines.length === 0 ? (
          <p className="px-4 py-3.5 text-kumo-subtle">{r("mineEmpty")}</p>
        ) : (
          <ul className="flex flex-col">
            {mine.length === 0 ? (
              <li className="flex min-h-11 items-center gap-2.5 border-b border-kumo-hairline px-4 text-kumo-subtle">
                <CheckCircleIcon size={18} weight="fill" className="shrink-0 text-kumo-success" aria-hidden />
                {t("noPending")}
              </li>
            ) : null}
            {lines.map((row) => (
              <RequestLine key={row.id} row={row} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );

  const side = (
    <div className="grid items-start gap-4 @2xl/page:grid-cols-2 @4xl/page:grid-cols-3 @5xl/page:grid-cols-1">
      <Card title={`${t("leaveLeft")} · ${year}`}>
        {balances.isPending ? (
          <SkeletonRows rows={1} />
        ) : balances.isError ? (
          <Pad>
            <Failed onRetry={() => void balances.refetch()} />
          </Pad>
        ) : balances.data.length === 0 ? (
          <p className="px-4 py-3.5 text-kumo-subtle">{r("balancesEmpty")}</p>
        ) : (
          <ul className="flex flex-col">
            {balances.data.map((one) => {
              const whole = one.entitled + one.carriedOver;
              return (
                <li key={one.leaveTypeId} className="flex flex-col gap-2 border-b border-kumo-hairline px-4 py-3 last:border-0">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate">{one.name}</span>
                    <span className="shrink-0 text-lg font-semibold tabular-nums">{days(one.remaining, locale)}</span>
                  </span>
                  {whole > 0 ? (
                    <span aria-hidden className="relative h-1.5 overflow-hidden rounded-full bg-kumo-fill">
                      <span
                        className="absolute inset-y-0 start-0 rounded-full bg-kumo-success"
                        style={{ width: `${Math.max(0, Math.min(100, (one.remaining / whole) * 100))}%` }}
                      />
                    </span>
                  ) : null}
                  <span className="text-sm text-kumo-subtle tabular-nums">
                    {t("leaveUsed", { taken: one.taken, pending: one.pending, whole })}
                    {one.bookedAfter > 0 ? ` · ${t("bookedAfter", { days: one.bookedAfter })}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {tally.data === null ? null : (
        <Card title={`${t("thisMonth")} · ${monthName}`}>
          {tally.isError ? (
            <Pad>
              <Failed onRetry={() => void tally.refetch()} />
            </Pad>
          ) : (
            <ul className="flex flex-col">
              {figures.map((one) => (
                <RowLink key={one.key} href={monthHref}>
                  <span className="min-w-0 flex-1 truncate">{t(one.key)}</span>
                  {one.value === undefined ? (
                    <span className="w-14">
                      <SkeletonLine minWidth={100} maxWidth={100} />
                    </span>
                  ) : (
                    <span className={cn("shrink-0 font-medium tabular-nums", one.warn && one.value > 0 && "text-kumo-warning")}>
                      {one.unit(one.value)}
                    </span>
                  )}
                </RowLink>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card title={t("latestPayslip")} link={{ href: "/me/payslips", label: nav("myPayslips") }}>
        {latest.isPending ? (
          <SkeletonRows rows={1} />
        ) : latest.isError ? (
          <Pad>
            <Failed onRetry={() => void latest.refetch()} />
          </Pad>
        ) : latest.data === null ? (
          <div className="flex flex-col gap-0.5 px-4 py-3.5">
            <span>{pay("empty")}</span>
            <span className="text-sm text-kumo-subtle">{t("noPayslipHint")}</span>
          </div>
        ) : (
          <ul className="flex flex-col">
            <RowLink href={`/me/payslips?slip=${latest.data.id}`}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">
                  {latest.data.period ? t("payslipOf", { month: latest.data.period.month, year: String(latest.data.period.year) }) : common("empty")}
                </span>
                <span className="text-sm text-kumo-subtle tabular-nums">{t("payslipDays", { count: Number(latest.data.workedDays) })}</span>
              </span>
              <span className="flex shrink-0 flex-col items-end">
                <span className="text-lg font-semibold tabular-nums">{money(Number(latest.data.netPay), locale)}</span>
                <span className="text-sm text-kumo-subtle">{pay("net")}</span>
              </span>
            </RowLink>
          </ul>
        )}
      </Card>
    </div>
  );

  return (
    <>
      <PageHeader
        title={me.data ? t("greeting", { name: me.data.fullName }) : t("title")}
        description={me.data ? [me.data.code, me.data.department?.name].filter(Boolean).join(" · ") : undefined}
        actions={
          <Button variant="primary" icon={CalendarPlusIcon} onClick={askLeave}>
            {t("askLeave")}
          </Button>
        }
      />
      <PageLayout aside={side}>{main}</PageLayout>
      <RequestForm key={seed} open={filing} onOpenChange={setFiling} kind="LEAVE" />
    </>
  );
}
