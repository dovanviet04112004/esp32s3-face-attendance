"use client";

import { Button, Empty, Input, LayerDialog, Loader, Select, SkeletonLine, Textarea } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, CalendarBlankIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { Failed } from "@/components/ui/failed";
import { FilterBar } from "@/components/ui/filter-bar";
import { MonthPicker, monthSpan, thisMonth, type Month } from "@/components/ui/month-picker";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill, type Tone } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { dayOnly, hours, minutes as asMinutes } from "@/lib/format";

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

function sameMonth(left: Month, right: Month): boolean {
  return left.year === right.year && left.month === right.month;
}

export default function TimesheetPage() {
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

  const [month, setMonth] = useState<Month>(thisMonth);
  const [departmentId, setDepartmentId] = useState("");
  const [openFor, setOpenFor] = useState<Summary | null>(null);
  const [editing, setEditing] = useState<Day | null>(null);
  const [state, setState] = useState<DayState>("WORKED");
  const [workMinutes, setWorkMinutes] = useState("");
  const [why, setWhy] = useState("");
  const [fault, setFault] = useState<string | null>(null);
  const [settling, setSettling] = useState<Settling | null>(null);

  const span = monthSpan(month);
  const monthName = format.dateTime(new Date(month.year, month.month - 1, 15), { month: "long", year: "numeric" });

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
    queryKey: ["timesheet", "summary", span.from, departmentId],
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({ from: span.from, to: span.to });
      if (departmentId) {
        params.set("departmentId", departmentId);
      }
      if (pageParam) {
        params.set("cursor", pageParam);
      }
      return (await api.get<SummaryPage>(`/timesheet/summary?${params.toString()}`)).data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const totals = useQuery({
    queryKey: ["timesheet", "totals", span.from, departmentId],
    queryFn: async () => {
      const params = new URLSearchParams({ from: span.from, to: span.to });
      if (departmentId) {
        params.set("departmentId", departmentId);
      }
      return (await api.get<Totals>(`/timesheet/totals?${params.toString()}`)).data;
    },
  });

  const days = useQuery({
    queryKey: ["timesheet", "days", openFor?.employeeId, span.from],
    enabled: openFor !== null,
    queryFn: async () =>
      (await api.get<Day[]>(`/timesheet?from=${span.from}&to=${span.to}&employeeId=${openFor?.employeeId}`)).data,
  });

  const rebuild = useMutation({
    mutationFn: async () => (await api.post<{ jobId: string }>("/timesheet/build", span)).data,
    onSuccess: (queued) => {
      notify.done(t("rebuildQueued", { month: monthName }), t("rebuildQueuedHint"));
      setSettling({ month, jobId: queued.jobId });
    },
    onError: notify.failed,
  });

  const correct = useMutation({
    mutationFn: (day: Day) =>
      api.patch(`/timesheet/${day.id}`, { state, workedMinutes: Number(workMinutes), reason: why.trim() }),
    onSuccess: () => {
      setEditing(null);
      notify.done(t("correctDone"));
      void cache.invalidateQueries({ queryKey: ["timesheet"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function startCorrecting(day: Day): void {
    setFault(null);
    setState(day.state === "ABSENT" ? "WORKED" : day.state);
    setWorkMinutes(String(day.workedMinutes));
    setWhy("");
    setEditing(day);
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
      sticky: true,
      sortBy: (row) => row.code,
      cell: (row) => (
        <span className="whitespace-nowrap">
          {row.fullName}
          <span className="ms-2 font-mono text-sm text-kumo-subtle">{row.code}</span>
        </span>
      ),
    },
    { id: "workedDays", header: t("workedDays"), numeric: true, sortBy: (row) => row.workedDays, cell: (row) => row.workedDays },
    {
      id: "absentDays",
      header: t("absentDays"),
      numeric: true,
      sortBy: (row) => row.absentDays,
      cell: (row) => <span className={row.absentDays > 0 ? "text-kumo-warning" : undefined}>{row.absentDays}</span>,
    },
    { id: "leaveDays", header: t("leaveDays"), numeric: true, sortBy: (row) => row.leaveDays, cell: (row) => row.leaveDays },
    {
      id: "workedHours",
      header: t("workedHours"),
      numeric: true,
      sortBy: (row) => row.workedMinutes,
      cell: (row) => hours(row.workedMinutes, locale),
    },
    {
      id: "lateMinutes",
      header: t("lateMinutes"),
      numeric: true,
      sortBy: (row) => row.lateMinutes,
      cell: (row) =>
        row.lateMinutes > 0 ? <span className="text-kumo-warning">{asMinutes(row.lateMinutes, locale)}</span> : common("empty"),
    },
    {
      id: "overtime",
      header: t("overtimeHours"),
      numeric: true,
      sortBy: (row) => row.overtimeMinutes,
      cell: (row) => (row.overtimeMinutes > 0 ? hours(row.overtimeMinutes, locale) : common("empty")),
    },
    {
      id: "adjusted",
      header: t("adjusted"),
      numeric: true,
      sortBy: (row) => row.adjustedDays,
      cell: (row) => (row.adjustedDays > 0 ? row.adjustedDays : common("empty")),
    },
  ];

  const rebuildButton = (
    <Button
      variant="secondary"
      icon={ArrowsClockwiseIcon}
      loading={rebuild.isPending}
      disabled={busyHere}
      onClick={() => rebuild.mutate()}
    >
      {t("rebuildMonth")}
    </Button>
  );

  return (
    <>
      <PageHeader title={t("title")} description={t("monthLead")} />

      <PageLayout
        aside={
          <AsideCard title={t("monthTotals", { month: monthName })}>
            <Facts
              rows={[
                [t("workedDays"), ready ? <span className="tabular-nums">{format.number(sum?.workedDays ?? 0)}</span> : common("empty")],
                [
                  t("absentDays"),
                  ready ? <span className={(sum?.absentDays ?? 0) > 0 ? "text-kumo-warning tabular-nums" : "tabular-nums"}>{format.number(sum?.absentDays ?? 0)}</span> : common("empty"),
                ],
                [t("leaveDays"), ready ? <span className="tabular-nums">{format.number(sum?.leaveDays ?? 0)}</span> : common("empty")],
                [t("overtimeHours"), ready ? <span className="tabular-nums">{hours(sum?.overtimeMinutes ?? 0, locale)}</span> : common("empty")],
                [t("adjusted"), ready ? <span className="tabular-nums">{format.number(sum?.adjustedDays ?? 0)}</span> : common("empty")],
              ]}
            />
            {sum && sum.people > 0 ? (
              <p className="mt-3 text-sm text-kumo-subtle">{t("totalsAll", { count: sum.people })}</p>
            ) : null}
          </AsideCard>
        }
        extra={
          mayRebuild ? (
            <AsideCard title={common("tools")}>
              <p className="mb-3 text-kumo-subtle">{t("rebuildLead")}</p>
              <div className="flex flex-col">{rebuildButton}</div>
              {settling ? (
                <p className="mt-3 flex items-center gap-2 text-sm text-kumo-subtle">
                  <Loader size={14} />
                  {t("rebuildSettling", {
                    month: format.dateTime(new Date(settling.month.year, settling.month.month - 1, 15), {
                      month: "long",
                      year: "numeric",
                    }),
                  })}
                </p>
              ) : null}
            </AsideCard>
          ) : undefined
        }
      >
        <FilterBar
          filters={[
            { key: "department", label: t("department"), value: departmentId, onChange: setDepartmentId, items: departmentItems },
          ]}
          extra={<MonthPicker value={month} onChange={setMonth} max={thisMonth()} />}
        />
        <DataTable
          id="timesheet"
          cardLead="employee"
          columns={columns}
          rows={shown}
          keyOf={(row) => String(row.employeeId)}
          pending={rows.isPending}
          failed={rows.isError}
          onRetry={() => void rows.refetch()}
          onRowClick={setOpenFor}
          empty={departmentId ? t("emptyDepartment") : t("emptyMonth")}
          emptyHint={mayRebuild ? t("emptyHint") : undefined}
          emptyAction={mayRebuild ? rebuildButton : undefined}
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
          <LayerDialog.Title>{openFor ? `${openFor.fullName} · ${monthName}` : t("days")}</LayerDialog.Title>
          <LayerDialog.Description>
            {openFor
              ? t("daysLead", { code: openFor.code, worked: openFor.workedDays, absent: openFor.absentDays, leave: openFor.leaveDays })
              : null}
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
              <Empty
                size="sm"
                icon={<CalendarBlankIcon size={32} className="text-kumo-inactive" />}
                title={t("daysEmpty")}
              />
            ) : (
              <ul className="flex flex-col">
                {days.data.map((day) => (
                  <li
                    key={day.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-kumo-hairline py-2 last:border-0"
                  >
                    <span className="w-24 tabular-nums">{format.dateTime(dayOnly(day.date), { weekday: "short", day: "numeric", month: "numeric" })}</span>
                    <span className="w-24">
                      <StatePill tone={TONE[day.state]}>{t(`state${day.state}`)}</StatePill>
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
                    <Input
                      label={t("correctMinutes")}
                      type="number"
                      min={0}
                      value={workMinutes}
                      description={workMinutes !== "" ? hours(Number(workMinutes), locale) : undefined}
                      onChange={(event) => setWorkMinutes(event.target.value)}
                    />
                    <Textarea
                      label={t("correctReason")}
                      required
                      rows={3}
                      maxLength={500}
                      value={why}
                      description={t("correctReasonHint")}
                      onChange={(event) => setWhy(event.target.value)}
                    />
                    {fault ? <p role="alert" className="text-kumo-danger">{fault}</p> : null}
                  </div>
                </LayerDialog.Body>
                <LayerDialog.Actions dismissLabel={common("cancel")}>
                  <LayerDialog.Actions.Primary
                    loading={correct.isPending}
                    disabled={why.trim() === "" || workMinutes === ""}
                    onClick={() => {
                      if (editing) {
                        setFault(null);
                        correct.mutate(editing);
                      }
                    }}
                  >
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
