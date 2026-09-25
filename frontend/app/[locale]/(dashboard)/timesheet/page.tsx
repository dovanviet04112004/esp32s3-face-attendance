"use client";

import { Banner, Button, Empty, Input, LayerDialog, Loader, Select, Textarea } from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon,
  CalendarBlankIcon,
  DownloadSimpleIcon,
  PencilSimpleIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Suspense, useEffect, useState } from "react";

import { DataTable, PersonCell, type Column } from "@/components/tables/data-table";
import { Failed } from "@/components/ui/failed";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { MonthPicker, monthSpan, thisMonth, type Month } from "@/components/ui/month-picker";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill, type Tone } from "@/components/ui/pill";
import { SkeletonLine } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { dayOnly, hours, minutes as asMinutes } from "@/lib/format";
import { useUrlState } from "@/lib/url-state";

type DayState = "WORKED" | "LEAVE" | "HOLIDAY" | "WEEKEND" | "ABSENT";

interface SummaryPage {
  rows: Summary[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
}

interface Summary {
  employeeId: number;
  code: string;
  fullName: string;
  workedDays: number;
  leaveDays: number;
  absentDays: number;
  workedMinutes: number;
  lateMinutes: number;
  overtimeMinutes: number;
  adjustedDays: number;
}

interface Day {
  id: string;
  employeeId: number;
  date: string;
  state: DayState;
  firstIn: string | null;
  lastOut: string | null;
  workedMinutes: number;
  lateMinutes: number;
  overtimeMinutes: number;
  measuredMinutes: number | null;
  adjustReason: string | null;
}

interface Department {
  id: string;
  name: string;
}

interface Settling {
  month: Month;
  jobId: string;
}

interface Totals {
  people: number;
  workedDays: number;
  absentDays: number;
  leaveDays: number;
  overtimeMinutes: number;
  adjustedDays: number;
}

type BuildState = "waiting" | "active" | "completed" | "failed" | "gone";

const STATES: DayState[] = ["WORKED", "LEAVE", "HOLIDAY", "WEEKEND", "ABSENT"];
const TONE: Record<DayState, Tone> = { WORKED: "good", LEAVE: "idle", HOLIDAY: "idle", WEEKEND: "idle", ABSENT: "bad" };
const BUILDERS = ["ADMIN", "HR", "PAYROLL"];
const kBuildPollMs = 3_000;
const kReasonMax = 500;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^(\d{4})-(\d{2})$/;

function sameMonth(left: Month, right: Month): boolean {
  return left.year === right.year && left.month === right.month;
}

function monthOf(raw: string): Month {
  const hit = raw.match(MONTH);
  const month = hit ? Number(hit[2]) : 0;
  return hit && month >= 1 && month <= 12 ? { year: Number(hit[1]), month } : thisMonth();
}

function monthText(at: Month): string {
  return `${at.year}-${String(at.month).padStart(2, "0")}`;
}

function clockOf(iso: string | null): string {
  if (!iso) {
    return "";
  }
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

function minutesOf(clock: string): number | null {
  const hit = clock.match(/^(\d{2}):(\d{2})$/);
  return hit ? Number(hit[1]) * 60 + Number(hit[2]) : null;
}

function save(text: string, name: string): void {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

function Timesheet() {
  const t = useTranslations("timesheet");
  const common = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();
  const role = useSession((s) => s.role);
  const mayCorrect = role === "ADMIN" || role === "HR";
  const mayRebuild = role !== null && BUILDERS.includes(role);
  const cache = useQueryClient();
  const notify = useNotify();
  const faultOf = useFault();

  const [url, setUrl] = useUrlState({ q: "", departmentId: "", exceptions: "", month: "", from: "", to: "" });
  const [typed, setTyped] = useState(url.q);
  const settled = useSettled(typed.trim());
  useEffect(() => {
    if (settled !== url.q) {
      setUrl({ q: settled });
    }
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps

  const month = monthOf(url.month);
  // A link from the home page names a range of days; picking a month goes back to whole months.
  const ranged = DAY.test(url.from) && DAY.test(url.to);
  const span = ranged ? { from: url.from, to: url.to } : monthSpan(month);

  const [openFor, setOpenFor] = useState<Summary | null>(null);
  const [editing, setEditing] = useState<Day | null>(null);
  const [state, setState] = useState<DayState>("WORKED");
  const [clockIn, setClockIn] = useState("");
  const [clockOut, setClockOut] = useState("");
  const [why, setWhy] = useState("");
  const [tried, setTried] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [settling, setSettling] = useState<Settling | null>(null);

  const monthName = format.dateTime(new Date(month.year, month.month - 1, 15), { month: "long", year: "numeric" });
  const spanName = ranged
    ? span.from === span.to
      ? format.dateTime(dayOnly(span.from), "day")
      : `${format.dateTime(dayOnly(span.from), "day")} – ${format.dateTime(dayOnly(span.to), "day")}`
    : monthName;

  function filtered(extra: Record<string, string> = {}): URLSearchParams {
    const params = new URLSearchParams({ from: span.from, to: span.to, ...extra });
    if (url.departmentId) {
      params.set("departmentId", url.departmentId);
    }
    if (url.q) {
      params.set("search", url.q);
    }
    return params;
  }
  const withFilter = filtered(url.exceptions ? { exceptions: "true" } : {});

  const build = useQuery({
    queryKey: ["timesheet", "build", settling?.jobId],
    enabled: settling !== null,
    refetchInterval: kBuildPollMs,
    queryFn: async () => (await api.get<{ state: BuildState }>(`/timesheet/build/${settling?.jobId}`)).data.state,
  });

  // The table is read again once, when the job that rebuilt it ends.
  useEffect(() => {
    if (!settling || !build.data || build.data === "waiting" || build.data === "active") {
      return;
    }
    setSettling(null);
    void cache.invalidateQueries({ queryKey: ["timesheet"] });
    if (build.data === "failed") {
      notify.failed(t("rebuildFailed"));
    } else {
      notify.done(t("rebuildDone"));
    }
  }, [build.data, settling, cache, notify, t]);

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Department[]>("/departments")).data,
  });

  const rows = useInfiniteQuery({
    queryKey: ["timesheet", "summary", withFilter.toString()],
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams(withFilter);
      if (pageParam) {
        params.set("cursor", pageParam);
      }
      return (await api.get<SummaryPage>(`/timesheet/summary?${params.toString()}`)).data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const totals = useQuery({
    queryKey: ["timesheet", "totals", withFilter.toString()],
    queryFn: async () => (await api.get<Totals>(`/timesheet/totals?${withFilter.toString()}`)).data,
  });

  // How many people each choice of the exceptions filter holds, for the counts inside it.
  const counts = useQuery({
    queryKey: ["timesheet", "totals", "counts", filtered().toString()],
    queryFn: async () => {
      const [all, odd] = await Promise.all([
        api.get<Totals>(`/timesheet/totals?${filtered().toString()}`),
        api.get<Totals>(`/timesheet/totals?${filtered({ exceptions: "true" }).toString()}`),
      ]);
      return { all: all.data.people, odd: odd.data.people };
    },
  });

  const days = useQuery({
    queryKey: ["timesheet", "days", openFor?.employeeId, span.from, span.to],
    enabled: openFor !== null,
    queryFn: async () =>
      (await api.get<Day[]>(`/timesheet?from=${span.from}&to=${span.to}&employeeId=${openFor?.employeeId}`)).data,
  });

  const rebuild = useMutation({
    mutationFn: async () => (await api.post<{ jobId: string }>("/timesheet/build", monthSpan(month))).data,
    onSuccess: (queued) => {
      notify.done(t("rebuildQueued", { month: monthName }), t("rebuildQueuedHint"));
      setSettling({ month, jobId: queued.jobId });
    },
    onError: notify.failed,
  });

  const exportCsv = useMutation({
    mutationFn: async () =>
      save((await api.get<string>(`/timesheet/summary/export?${withFilter.toString()}`)).data, `timesheet-${span.from}-${span.to}.csv`),
    onSuccess: () => notify.done(t("exported")),
    onError: notify.failed,
  });

  const inAt = minutesOf(clockIn);
  const outAt = minutesOf(clockOut);
  const worked = inAt !== null && outAt !== null && outAt > inAt ? outAt - inAt : null;
  const needsClock = state === "WORKED";
  const clockProblem = needsClock && worked === null ? t("correctClockInvalid") : undefined;
  const reasonProblem = why.trim() === "" ? t("correctReasonMissing") : undefined;

  const correct = useMutation({
    mutationFn: (day: Day) =>
      api.patch(`/timesheet/${day.id}`, {
        state,
        ...(needsClock && worked !== null ? { workedMinutes: worked } : {}),
        reason: why.trim(),
      }),
    onSuccess: () => {
      setEditing(null);
      notify.done(t("correctDone"));
      void cache.invalidateQueries({ queryKey: ["timesheet"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function startCorrecting(day: Day): void {
    setFault(null);
    setTried(false);
    setState(day.state === "ABSENT" ? "WORKED" : day.state);
    setClockIn(clockOf(day.firstIn));
    setClockOut(clockOf(day.lastOut));
    setWhy("");
    setEditing(day);
  }

  function submitCorrection(): void {
    setTried(true);
    if (!editing || clockProblem || reasonProblem) {
      return;
    }
    setFault(null);
    correct.mutate(editing);
  }

  const shown = rows.data?.pages.flatMap((one) => one.rows);
  const first = rows.data?.pages[0];
  const sum = totals.data;
  const ready = sum !== undefined;
  const busyHere = settling !== null && sameMonth(settling.month, month);

  const departmentItems: Record<string, string> = {
    "": t("allDepartments"),
    ...Object.fromEntries((departments.data ?? []).map((one) => [one.id, one.name])),
  };
  const stateItems = Object.fromEntries(STATES.map((one) => [one, t(`state${one}`)])) as Record<DayState, string>;

  const columns: Column<Summary>[] = [
    {
      id: "employee",
      header: t("employee"),
      cell: (row) => <PersonCell name={row.fullName} code={row.code} />,
    },
    { id: "workedDays", header: t("workedDays"), numeric: true, cell: (row) => row.workedDays },
    {
      id: "absentDays",
      header: t("absentDays"),
      numeric: true,
      cell: (row) => <span className={row.absentDays > 0 ? "text-kumo-warning" : undefined}>{row.absentDays}</span>,
    },
    { id: "leaveDays", header: t("leaveDays"), numeric: true, priority: 3, cell: (row) => row.leaveDays },
    {
      id: "workedHours",
      header: t("workedHours"),
      numeric: true,
      priority: 3,
      cell: (row) => hours(row.workedMinutes, locale),
    },
    {
      id: "lateMinutes",
      header: t("lateMinutes"),
      numeric: true,
      priority: 2,
      cell: (row) =>
        row.lateMinutes > 0 ? <span className="text-kumo-warning">{asMinutes(row.lateMinutes, locale)}</span> : common("empty"),
    },
    {
      id: "overtime",
      header: t("overtimeHours"),
      numeric: true,
      priority: 3,
      cell: (row) => (row.overtimeMinutes > 0 ? hours(row.overtimeMinutes, locale) : common("empty")),
    },
    {
      id: "adjusted",
      header: t("adjusted"),
      numeric: true,
      priority: 2,
      cell: (row) => (row.adjustedDays > 0 ? row.adjustedDays : common("empty")),
    },
  ];

  const rebuildButton = (
    <Button variant="secondary" icon={ArrowsClockwiseIcon} loading={rebuild.isPending} disabled={busyHere} onClick={() => rebuild.mutate()}>
      {t("rebuildMonth")}
    </Button>
  );

  return (
    <>
      <PageHeader title={t("title")} description={t("monthLead")} />

      <PageLayout
        aside={
          <AsideCard title={t("monthTotals", { month: spanName })}>
            <Facts
              rows={[
                [t("workedDays"), ready ? <span className="tabular-nums">{format.number(sum?.workedDays ?? 0)}</span> : common("empty")],
                [
                  t("absentDays"),
                  ready ? (
                    <span className={(sum?.absentDays ?? 0) > 0 ? "text-kumo-warning tabular-nums" : "tabular-nums"}>
                      {format.number(sum?.absentDays ?? 0)}
                    </span>
                  ) : (
                    common("empty")
                  ),
                ],
                [t("leaveDays"), ready ? <span className="tabular-nums">{format.number(sum?.leaveDays ?? 0)}</span> : common("empty")],
                [t("overtimeHours"), ready ? <span className="tabular-nums">{hours(sum?.overtimeMinutes ?? 0, locale)}</span> : common("empty")],
                [t("adjusted"), ready ? <span className="tabular-nums">{format.number(sum?.adjustedDays ?? 0)}</span> : common("empty")],
              ]}
            />
            {sum && sum.people > 0 ? <p className="mt-3 text-sm text-kumo-subtle">{t("totalsAll", { count: sum.people })}</p> : null}
          </AsideCard>
        }
        extra={
          <AsideCard title={common("tools")}>
            <div className="flex flex-col gap-3">
              <Button
                variant="secondary"
                icon={DownloadSimpleIcon}
                loading={exportCsv.isPending}
                disabled={!first || first.total === 0}
                onClick={() => exportCsv.mutate()}
                className="w-full justify-start"
              >
                {t("exportFilter")}
              </Button>
              {mayRebuild ? (
                <>
                  <p className="text-kumo-subtle">{t("rebuildLead")}</p>
                  {rebuildButton}
                  {settling ? (
                    <p className="flex items-center gap-2 text-sm text-kumo-subtle">
                      <Loader size={14} />
                      {t("rebuildSettling", {
                        month: format.dateTime(new Date(settling.month.year, settling.month.month - 1, 15), {
                          month: "long",
                          year: "numeric",
                        }),
                      })}
                    </p>
                  ) : null}
                </>
              ) : null}
            </div>
          </AsideCard>
        }
      >
        <FilterBar
          search={{ value: typed, onChange: setTyped, placeholder: t("searchHint") }}
          filters={[
            {
              key: "department",
              label: t("department"),
              value: url.departmentId,
              searchable: true,
              onChange: (value) => setUrl({ departmentId: value }),
              items: departmentItems,
            },
            {
              key: "exceptions",
              label: t("showLabel"),
              value: url.exceptions,
              onChange: (value) => setUrl({ exceptions: value }),
              items: { "": t("showAll"), true: t("showExceptions") },
              counts: { "": counts.data?.all, true: counts.data?.odd },
            },
          ]}
          extra={
            ranged ? (
              <Button variant="secondary" icon={XIcon} onClick={() => setUrl({ from: "", to: "" })}>
                {spanName}
              </Button>
            ) : (
              <MonthPicker
                value={month}
                onChange={(next) => setUrl({ month: sameMonth(next, thisMonth()) ? "" : monthText(next), from: "", to: "" })}
                max={thisMonth()}
              />
            )
          }
        />
        <DataTable
          id="timesheet"
          cardLead="employee"
          cardTrailing="absentDays"
          columns={columns}
          rows={shown}
          keyOf={(row) => String(row.employeeId)}
          pending={rows.isPending}
          failed={rows.isError}
          onRetry={() => void rows.refetch()}
          onRowClick={setOpenFor}
          empty={url.q || url.departmentId || url.exceptions ? common("noMatch") : t("emptyMonth")}
          emptyHint={mayRebuild && !url.q && !url.departmentId && !url.exceptions ? t("emptyHint") : undefined}
          emptyAction={mayRebuild && !url.q && !url.departmentId && !url.exceptions ? rebuildButton : undefined}
          paging={
            first
              ? {
                  shown: shown?.length ?? 0,
                  total: first.total,
                  exact: first.totalIsExact,
                  onMore: rows.hasNextPage ? () => void rows.fetchNextPage() : undefined,
                  loading: rows.isFetchingNextPage,
                }
              : undefined
          }
        />
      </PageLayout>

      <LayerDialog.Root open={openFor !== null} onOpenChange={(next) => !next && setOpenFor(null)}>
        <LayerDialog.Content size="lg" closeLabel={common("close")}>
          <LayerDialog.Title>{openFor ? `${openFor.fullName} · ${spanName}` : t("days")}</LayerDialog.Title>
          <LayerDialog.Description>
            {openFor ? t("daysLead", { code: openFor.code, worked: openFor.workedDays, absent: openFor.absentDays, leave: openFor.leaveDays }) : null}
          </LayerDialog.Description>
          <LayerDialog.Body>
            {days.isError ? (
              <Failed onRetry={() => void days.refetch()} />
            ) : days.isPending ? (
              <div className="flex flex-col gap-3 py-2">
                {Array.from({ length: 5 }, (_, at) => (
                  <SkeletonLine key={at} minWidth={27} maxWidth={70} />
                ))}
              </div>
            ) : days.data.length === 0 ? (
              <Empty size="sm" icon={<CalendarBlankIcon size={32} className="text-kumo-inactive" />} title={t("daysEmpty")} />
            ) : (
              <ul className="flex flex-col">
                {days.data.map((day) => (
                  <li key={day.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-kumo-hairline py-2 last:border-0">
                    <span className="w-24 tabular-nums">
                      {format.dateTime(dayOnly(day.date), { weekday: "short", day: "numeric", month: "numeric" })}
                    </span>
                    <span className="w-24">
                      <StatePill tone={TONE[day.state]}>{t(`state${day.state}`)}</StatePill>
                    </span>
                    <span className="w-24 text-sm text-kumo-subtle tabular-nums">
                      {day.firstIn ? `${clockOf(day.firstIn)}–${clockOf(day.lastOut)}` : common("empty")}
                    </span>
                    <span className="w-14 text-end tabular-nums">{hours(day.workedMinutes, locale)}</span>
                    {day.lateMinutes > 0 ? (
                      <span className="text-sm text-kumo-warning tabular-nums">{t("lateBy", { late: asMinutes(day.lateMinutes, locale) })}</span>
                    ) : null}
                    {day.overtimeMinutes > 0 ? (
                      <span className="text-sm text-kumo-subtle tabular-nums">{t("overtimeBy", { overtime: hours(day.overtimeMinutes, locale) })}</span>
                    ) : null}
                    {mayCorrect ? (
                      <Button variant="ghost" size="sm" icon={PencilSimpleIcon} className="ms-auto" onClick={() => startCorrecting(day)}>
                        {t("correct")}
                      </Button>
                    ) : null}
                    {day.adjustReason ? (
                      <p className="w-full text-sm text-kumo-subtle">
                        {t("adjustedNote", { measured: hours(day.measuredMinutes ?? 0, locale), reason: day.adjustReason })}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            <LayerDialog.Root open={editing !== null} onOpenChange={(next) => !next && setEditing(null)} dismissDisabled={correct.isPending}>
              <LayerDialog.Content closeLabel={common("close")}>
                <LayerDialog.Title>{t("correctTitle")}</LayerDialog.Title>
                <LayerDialog.Description>
                  {editing && openFor
                    ? t("correctLead", {
                        name: openFor.fullName,
                        day: format.dateTime(dayOnly(editing.date), "day"),
                        measured: hours(editing.measuredMinutes ?? editing.workedMinutes, locale),
                      })
                    : null}
                </LayerDialog.Description>
                <LayerDialog.Body>
                  <div className="flex flex-col gap-4">
                    <Select
                      label={t("correctState")}
                      hideLabel={false}
                      value={state}
                      onValueChange={(next) => setState(next as DayState)}
                      items={stateItems}
                      className="w-full"
                    />
                    {needsClock ? (
                      <div className="grid grid-cols-2 gap-3">
                        <Input label={t("correctIn")} type="time" value={clockIn} onChange={(event) => setClockIn(event.target.value)} />
                        <Input
                          label={t("correctOut")}
                          type="time"
                          value={clockOut}
                          error={tried ? clockProblem : undefined}
                          description={worked !== null ? t("correctWorked", { worked: hours(worked, locale) }) : undefined}
                          onChange={(event) => setClockOut(event.target.value)}
                        />
                      </div>
                    ) : null}
                    <Textarea
                      label={t("correctReason")}
                      rows={3}
                      maxLength={kReasonMax}
                      value={why}
                      error={tried ? reasonProblem : undefined}
                      description={t("correctReasonHint")}
                      onChange={(event) => setWhy(event.target.value)}
                    />
                    {fault ? <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null}
                  </div>
                </LayerDialog.Body>
                <LayerDialog.Actions dismissLabel={common("cancel")}>
                  <LayerDialog.Actions.Primary loading={correct.isPending} onClick={submitCorrection}>
                    {t("correctSave")}
                  </LayerDialog.Actions.Primary>
                </LayerDialog.Actions>
              </LayerDialog.Content>
            </LayerDialog.Root>
          </LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}

export default function TimesheetPage() {
  return (
    <Suspense>
      <Timesheet />
    </Suspense>
  );
}
