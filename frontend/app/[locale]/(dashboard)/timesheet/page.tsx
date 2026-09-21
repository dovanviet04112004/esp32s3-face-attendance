"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { dayOnly, hours, minutes as asMinutes } from "@/lib/format";

type DayState = "WORKED" | "LEAVE" | "HOLIDAY" | "WEEKEND" | "ABSENT";

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

const STATE_KEY: Record<
  DayState,
  "stateWORKED" | "stateLEAVE" | "stateHOLIDAY" | "stateWEEKEND" | "stateABSENT"
> = {
  WORKED: "stateWORKED",
  LEAVE: "stateLEAVE",
  HOLIDAY: "stateHOLIDAY",
  WEEKEND: "stateWEEKEND",
  ABSENT: "stateABSENT",
};

function monthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function TimesheetPage() {
  const t = useTranslations("timesheet");
  const format = useFormatter();
  const common = useTranslations("common");
  const locale = useLocale();
  const role = useSession((s) => s.role);
  const mayCorrect = role === "ADMIN" || role === "HR";
  const cache = useQueryClient();

  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [departmentId, setDepartmentId] = useState("");
  const [range, setRange] = useState({ from: monthStart(), to: today() });
  const [openFor, setOpenFor] = useState<Summary | null>(null);
  const [editing, setEditing] = useState<Day | null>(null);
  const [why, setWhy] = useState("");
  const [workMinutes, setWorkMinutes] = useState("");

  const where = `from=${range.from}&to=${range.to}${departmentId ? `&departmentId=${departmentId}` : ""}`;

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Department[]>("/departments")).data,
  });

  const rows = useQuery({
    queryKey: ["timesheet", "summary", where],
    queryFn: async () => (await api.get<Summary[]>(`/timesheet/summary?${where}`)).data,
  });

  const days = useQuery({
    queryKey: ["timesheet", "days", openFor?.employeeId, range],
    enabled: openFor !== null,
    queryFn: async () =>
      (
        await api.get<Day[]>(
          `/timesheet?from=${range.from}&to=${range.to}&employeeId=${openFor?.employeeId}`,
        )
      ).data,
  });

  const rebuild = useMutation({
    mutationFn: async () =>
      (await api.post<{ jobId: string }>("/timesheet/build", { from: range.from, to: range.to }))
        .data,
  });

  const correct = useMutation({
    mutationFn: (day: Day) =>
      api.patch(`/timesheet/${day.id}`, {
        state: "WORKED",
        workedMinutes: Number(workMinutes),
        reason: why,
      }),
    onSuccess: () => {
      setEditing(null);
      setWhy("");
      setWorkMinutes("");
      void cache.invalidateQueries({ queryKey: ["timesheet"] });
    },
  });

  function apply(event: FormEvent): void {
    event.preventDefault();
    setRange({ from, to });
  }

  const columns: Column<Summary>[] = [
    {
      id: "employee",
      header: t("employee"),
      sticky: true,
      sortBy: (row) => row.code,
      cell: (row) => (
        <button
          type="button"
          onClick={() => setOpenFor(row)}
          className="text-start text-(--color-accent) hover:underline"
        >
          <span className="block">{row.fullName}</span>
          <span className="block font-mono text-xs text-(--color-muted)">{row.code}</span>
        </button>
      ),
    },
    {
      id: "workedDays",
      header: t("workedDays"),
      numeric: true,
      sortBy: (row) => row.workedDays,
      cell: (row) => row.workedDays,
    },
    {
      id: "leaveDays",
      header: t("leaveDays"),
      numeric: true,
      sortBy: (row) => row.leaveDays,
      cell: (row) => row.leaveDays,
    },
    {
      id: "absentDays",
      header: t("absentDays"),
      numeric: true,
      sortBy: (row) => row.absentDays,
      cell: (row) => (
        <span className={row.absentDays > 0 ? "text-(--color-warn)" : undefined}>
          {row.absentDays}
        </span>
      ),
    },
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
        row.lateMinutes > 0 ? (
          <span className="text-(--color-warn)">{asMinutes(row.lateMinutes, locale)}</span>
        ) : (
          common("empty")
        ),
    },
    {
      id: "overtime",
      header: t("overtime"),
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

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 mb-4 text-sm text-(--color-muted)">{t("lead")}</p>

      <FilterBar
        onApply={apply}
        extra={
          mayCorrect ? (
            <Button
              type="button"
              tone="quiet"
              disabled={rebuild.isPending}
              onClick={() => rebuild.mutate()}
            >
              {rebuild.isPending ? t("rebuilding") : t("rebuild")}
            </Button>
          ) : null
        }
      >
        <div>
          <label className="block text-xs text-(--color-muted)" htmlFor="from">
            {t("from")}
          </label>
          <Input
            id="from"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="w-44"
          />
        </div>
        <div>
          <label className="block text-xs text-(--color-muted)" htmlFor="to">
            {t("to")}
          </label>
          <Input
            id="to"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="w-44"
          />
        </div>
        <div className="min-w-44 flex-1">
          <label className="block text-xs text-(--color-muted)" htmlFor="department">
            {t("department")}
          </label>
          <Select
            id="department"
            value={departmentId}
            onChange={(event) => setDepartmentId(event.target.value)}
          >
            <option value="">{t("allDepartments")}</option>
            {(departments.data ?? []).map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </Select>
        </div>
      </FilterBar>

      {rebuild.data ? (
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <p className="text-sm text-(--color-ok)">{t("buildQueued")}</p>
          <Button
            type="button"
            tone="quiet"
            size="sm"
            onClick={() => void cache.invalidateQueries({ queryKey: ["timesheet"] })}
          >
            {t("refresh")}
          </Button>
        </div>
      ) : null}

      <DataTable
        id="timesheet"
        columns={columns}
        rows={rows.data}
        keyOf={(row) => String(row.employeeId)}
        pending={rows.isPending}
        failed={rows.isError}
        onRetry={() => rows.refetch()}
        empty={t("empty")}
        emptyHint={t("emptyHint")}
      />

      <Sheet
        open={openFor !== null}
        onClose={() => setOpenFor(null)}
        title={openFor ? `${openFor.fullName} · ${t("days")}` : t("days")}
        closeLabel={common("close")}
        className="sm:max-w-2xl"
      >
        <div className="flex flex-col">
          {(days.data ?? []).map((day) => (
            <div
              key={day.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-(--color-line) py-2 text-sm last:border-0"
            >
              <span className="tabular-nums">{format.dateTime(dayOnly(day.date), "day")}</span>
              <span className={cn(day.state === "ABSENT" && "text-(--color-warn)")}>
                {t(STATE_KEY[day.state])}
              </span>
              <span className="tabular-nums">{hours(day.workedMinutes, locale)}</span>
              {day.adjustReason ? (
                <span className="text-xs text-(--color-muted)">
                  {t("measured")}: {hours(day.measuredMinutes ?? 0, locale)} · {day.adjustReason}
                </span>
              ) : null}
              {mayCorrect ? (
                <Button
                  type="button"
                  tone="quiet"
                  size="sm"
                  onClick={() => {
                    setEditing(day);
                    setWorkMinutes(String(day.workedMinutes));
                  }}
                >
                  {t("correct")}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      </Sheet>

      <Sheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={t("correctTitle")}
        closeLabel={common("close")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (editing) {
              correct.mutate(editing);
            }
          }}
        >
          <label className="block text-sm font-medium" htmlFor="workMinutes">
            {t("correctMinutes")}
          </label>
          <Input
            id="workMinutes"
            type="number"
            min={0}
            required
            value={workMinutes}
            onChange={(event) => setWorkMinutes(event.target.value)}
            className="mt-1"
          />
          <label className="mt-4 block text-sm font-medium" htmlFor="why">
            {t("correctReason")}
          </label>
          <Input
            id="why"
            required
            maxLength={500}
            value={why}
            onChange={(event) => setWhy(event.target.value)}
            className="mt-1"
          />
          <p className="mt-2 text-xs text-(--color-muted)">
            {t("measured")}: {hours(editing?.measuredMinutes ?? editing?.workedMinutes ?? 0, locale)}
          </p>
          <Button type="submit" disabled={correct.isPending} className="mt-4">
            {correct.isPending ? common("saving") : common("save")}
          </Button>
        </form>
      </Sheet>
    </section>
  );
}
