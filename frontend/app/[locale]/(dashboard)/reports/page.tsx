"use client";

import { Button, Empty, LayerCard, Select } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, BuildingsIcon, DownloadSimpleIcon } from "@phosphor-icons/react";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Suspense, useEffect, useState, type ReactNode } from "react";

import { DataTable, PersonCell, type Column } from "@/components/tables/data-table";
import { DateField } from "@/components/ui/date-field";
import { Failed } from "@/components/ui/failed";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { MonthPicker, monthSpan, shiftMonth, thisMonth, type Month } from "@/components/ui/month-picker";
import { useNotify } from "@/components/ui/notify";
import { PageHeader } from "@/components/ui/page";
import { StatePill, type Tone } from "@/components/ui/pill";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { dayOnly, hours, money } from "@/lib/format";
import { useUrlState } from "@/lib/url-state";

interface Entity {
  id: string;
  name: string;
}

type Reason = "HIRED" | "LEFT" | "UNPAID_14" | "SALARY_UP" | "SALARY_DOWN";

interface Change {
  employeeId: number;
  code: string;
  fullName: string;
  socialInsuranceNo: string | null;
  reason: Reason;
  effectiveFrom: string;
  fromSalary: string | null;
  toSalary: string | null;
}

interface Changes {
  unpaidDayThreshold: number;
  increases: Change[];
  decreases: Change[];
  adjustments: Change[];
}

interface DayTotals {
  people: number;
  workedDays: number;
  leaveDays: number;
  absentDays: number;
  lateMinutes: number;
  overtimeMinutes: number;
}

interface Period {
  id: string;
  legalEntityId: string;
  year: number;
  month: number;
  state: "OPEN" | "LOCKED" | "PAID";
}

interface PeriodTotals {
  payslips: number;
  gross: string;
  net: string;
  employerCost: string;
}

interface MonthRow {
  at: Month;
  totals: DayTotals;
}

interface PeriodRow {
  period: Period;
  totals: PeriodTotals;
}

type Filing = "increases" | "decreases" | "adjustments";

const FILINGS: Filing[] = ["increases", "decreases", "adjustments"];
const REASON_TONE: Record<Reason, Tone> = {
  HIRED: "good",
  LEFT: "idle",
  UNPAID_14: "waiting",
  SALARY_UP: "good",
  SALARY_DOWN: "waiting",
};
const PERIOD_TONE: Record<Period["state"], Tone> = { OPEN: "waiting", LOCKED: "idle", PAID: "good" };
const kTrend = 6;
const kPage = 15;
const MONTH = /^(\d{4})-(\d{2})$/;

function localDay(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

function monthOf(raw: string): Month {
  const hit = raw.match(MONTH);
  const month = hit ? Number(hit[2]) : 0;
  return hit && month >= 1 && month <= 12 ? { year: Number(hit[1]), month } : thisMonth();
}

function monthKey(at: Month): string {
  return `${at.year}-${String(at.month).padStart(2, "0")}`;
}

function order(at: Month): number {
  return at.year * 12 + at.month;
}

// The same span the Punches page asks for, so the job warms exactly what that page reads.
function monthBounds(at: Month): { from: string; to: string } {
  const start = new Date(at.year, at.month - 1, 1);
  const end = new Date(new Date(at.year, at.month, 1).getTime() - 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** The day a roster report defaults to: the month's last day, or today while the month runs. */
function rosterDay(at: Month): string {
  const today = localDay(new Date());
  const last = monthSpan(at).to;
  return last < today ? last : today;
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

function Section({ title, lead, link, children }: { title: string; lead: ReactNode; link?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="m-0 text-lg font-semibold">{title}</h2>
          <p className="text-pretty text-kumo-subtle">{lead}</p>
        </div>
        {link}
      </div>
      {children}
    </section>
  );
}

function SeeAll({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="shrink-0 text-kumo-link hover:underline">
      {children}
    </Link>
  );
}

/** A trailing figure, which on a phone card has no column header above it to name it. */
function Named({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="flex flex-col items-end">
      <span className="whitespace-nowrap tabular-nums">{children}</span>
      <span className="text-sm text-kumo-subtle md:hidden">{label}</span>
    </span>
  );
}

function Reports() {
  const t = useTranslations("reports");
  const pay = useTranslations("payroll");
  const nav = useTranslations("nav");
  const format = useFormatter();
  const locale = useLocale();
  const notify = useNotify();
  const role = useSession((s) => s.role);
  const mayRollUp = role === "ADMIN" || role === "HR";

  const [url, setUrl] = useUrlState({ entity: "", month: "", q: "", filing: "" });
  const [typed, setTyped] = useState(url.q);
  const settled = useSettled(typed.trim());
  useEffect(() => {
    if (settled !== url.q) {
      setUrl({ q: settled });
    }
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps

  const month = monthOf(url.month);
  const key = monthKey(month);
  const span = monthSpan(month);
  const [on, setOn] = useState(() => rosterDay(month));
  const [shown, setShown] = useState(kPage);
  const monthName = format.dateTime(new Date(month.year, month.month - 1, 15), { month: "numeric", year: "numeric" });
  const nameOf = (at: Month) => format.dateTime(new Date(at.year, at.month - 1, 15), { month: "numeric", year: "numeric" });
  const filing = (FILINGS as string[]).includes(url.filing) ? (url.filing as Filing) : "";

  useEffect(() => {
    setOn(rosterDay(month));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const entities = useQuery({
    queryKey: ["legal-entities"],
    queryFn: async () => (await api.get<Entity[]>("/legal-entities")).data,
  });
  const entity = url.entity || entities.data?.[0]?.id || "";
  const entityName = entities.data?.find((one) => one.id === entity)?.name ?? "";

  const trendMonths = Array.from({ length: kTrend }, (_, at) => shiftMonth(month, -at));
  const attendance = useQueries({
    queries: trendMonths.map((at) => {
      const range = monthSpan(at);
      return {
        queryKey: ["timesheet", "totals", "report", range.from, range.to],
        queryFn: async () => (await api.get<DayTotals>(`/timesheet/totals?from=${range.from}&to=${range.to}`)).data,
      };
    }),
  });
  const attendanceRows: MonthRow[] | undefined = attendance.every((one) => one.data)
    ? trendMonths.map((at, index) => ({ at, totals: attendance[index].data as DayTotals }))
    : undefined;

  const periods = useQuery({
    queryKey: ["payroll-periods"],
    queryFn: async () => (await api.get<Period[]>("/payroll-periods")).data,
  });
  const lastPeriods = (periods.data ?? [])
    .filter((one) => one.legalEntityId === entity && order(one) <= order(month))
    .sort((left, right) => order(right) - order(left))
    .slice(0, kTrend);
  const periodTotals = useQueries({
    queries: lastPeriods.map((one) => ({
      queryKey: ["payroll-periods", one.id, "totals"],
      queryFn: async () => (await api.get<PeriodTotals>(`/payroll-periods/${one.id}/totals`)).data,
    })),
  });
  const periodRows: PeriodRow[] | undefined =
    periods.data && periodTotals.every((one) => one.data)
      ? lastPeriods.map((period, index) => ({ period, totals: periodTotals[index].data as PeriodTotals }))
      : undefined;

  const changes = useQuery({
    queryKey: ["reports", "insurance-changes", entity, span.from],
    enabled: entity !== "",
    queryFn: async () =>
      (await api.get<Changes>(`/reports/insurance-changes?legalEntityId=${entity}&from=${span.from}&to=${span.to}`)).data,
  });

  // A new month, entity, kind or search starts the list at its first page again.
  useEffect(() => {
    setShown(kPage);
  }, [entity, span.from, url.q, filing]);

  const d02 = useMutation({
    mutationFn: async () => {
      const file = (await api.get<string>(`/reports/d02-lt?legalEntityId=${entity}&on=${on}`)).data;
      const link = document.createElement("a");
      // The api already opens the file with a BOM, so this must not add one.
      link.href = URL.createObjectURL(new Blob([file], { type: "text/csv;charset=utf-8" }));
      link.download = `d02-lt-${on}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    },
    onSuccess: () => notify.done(t("d02Done", { date: format.dateTime(dayOnly(on), "day") })),
    onError: notify.failed,
  });

  const rollUp = useMutation({
    mutationFn: async () => (await api.post<{ jobId: string }>("/reports/attendance/monthly", monthBounds(month))).data,
    onSuccess: () => notify.done(t("rollUpQueued", { month: monthName }), t("rollUpQueuedHint")),
    onError: notify.failed,
  });

  const needle = fold(url.q);
  const matches = (row: Change) => needle === "" || fold(row.code).includes(needle) || fold(row.fullName).includes(needle);
  const every = changes.data ? FILINGS.flatMap((one) => changes.data[one]) : undefined;
  const picked = changes.data ? (filing ? changes.data[filing] : (every ?? [])).filter(matches) : undefined;
  const counts = changes.data
    ? {
        "": FILINGS.reduce((sum, one) => sum + changes.data[one].filter(matches).length, 0),
        ...Object.fromEntries(FILINGS.map((one) => [one, changes.data[one].filter(matches).length])),
      }
    : undefined;
  const cash = (raw: string | null) => (raw === null ? "" : money(Number(raw), locale));
  const isNow = (at: Month) => order(at) === order(thisMonth());

  const attendanceColumns: Column<MonthRow>[] = [
    {
      id: "month",
      header: t("colMonth"),
      cell: (row) => (
        <span className={cn("flex items-center gap-2 whitespace-nowrap tabular-nums", order(row.at) === order(month) && "font-medium")}>
          {nameOf(row.at)}
          {isNow(row.at) ? <StatePill tone="waiting">{t("running")}</StatePill> : null}
        </span>
      ),
    },
    { id: "people", header: t("colPeople"), numeric: true, priority: 3, cell: (row) => format.number(row.totals.people) },
    { id: "worked", header: t("colWorked"), numeric: true, priority: 2, cell: (row) => format.number(row.totals.workedDays) },
    { id: "leave", header: t("colLeave"), numeric: true, priority: 3, cell: (row) => format.number(row.totals.leaveDays) },
    {
      id: "absent",
      header: t("colAbsent"),
      numeric: true,
      cell: (row) => <Named label={t("colAbsent")}>{format.number(row.totals.absentDays)}</Named>,
    },
    { id: "overtime", header: t("colOvertime"), numeric: true, priority: 2, cell: (row) => hours(row.totals.overtimeMinutes, locale) },
    { id: "late", header: t("colLate"), numeric: true, priority: 3, cell: (row) => hours(row.totals.lateMinutes, locale) },
  ];

  // A period not run yet has no payslips, and its zeros would read as a month paid nothing.
  const sum = (row: PeriodRow, raw: string) => (row.totals.payslips === 0 ? "—" : cash(raw));
  const payColumns: Column<PeriodRow>[] = [
    {
      id: "period",
      header: t("colPeriod"),
      cell: (row) => (
        <span className={cn("flex items-center gap-2 whitespace-nowrap tabular-nums", order(row.period) === order(month) && "font-medium")}>
          {nameOf(row.period)}
          <StatePill tone={PERIOD_TONE[row.period.state]}>{pay(`state${row.period.state}`)}</StatePill>
        </span>
      ),
    },
    { id: "payslips", header: t("colPayslips"), numeric: true, priority: 3, cell: (row) => format.number(row.totals.payslips) },
    { id: "gross", header: t("colGross"), numeric: true, priority: 3, cell: (row) => sum(row, row.totals.gross) },
    { id: "net", header: t("colNet"), numeric: true, priority: 2, cell: (row) => sum(row, row.totals.net) },
    {
      id: "cost",
      header: t("colCost"),
      numeric: true,
      cell: (row) => <Named label={t("colCost")}>{sum(row, row.totals.employerCost)}</Named>,
    },
  ];

  const changeColumns: Column<Change>[] = [
    { id: "who", header: t("colEmployee"), cell: (row) => <PersonCell name={row.fullName} code={row.code} /> },
    {
      id: "number",
      header: t("colInsuranceNo"),
      priority: 3,
      cell: (row) => <span className="font-mono text-sm">{row.socialInsuranceNo ?? "—"}</span>,
    },
    { id: "reason", header: t("colReason"), cell: (row) => <StatePill tone={REASON_TONE[row.reason]}>{t(`reason${row.reason}`)}</StatePill> },
    ...(picked?.some((row) => row.fromSalary !== null && row.toSalary !== null)
      ? [
          {
            id: "base",
            header: t("colBase"),
            numeric: true,
            priority: 2,
            cell: (row: Change) =>
              row.fromSalary !== null && row.toSalary !== null ? (
                <span className="whitespace-nowrap tabular-nums">
                  {cash(row.fromSalary)} → {cash(row.toSalary)}
                </span>
              ) : (
                <span className="text-kumo-subtle">—</span>
              ),
          } satisfies Column<Change>,
        ]
      : []),
    {
      id: "from",
      header: t("colFrom"),
      numeric: true,
      priority: 2,
      cell: (row) => <span className="whitespace-nowrap">{format.dateTime(dayOnly(row.effectiveFrom), "day")}</span>,
    },
  ];

  const entityItems = Object.fromEntries((entities.data ?? []).map((one) => [one.id, one.name]));
  const filingItems: Record<string, string> = {
    "": t("filingAll"),
    increases: t("increases"),
    decreases: t("decreases"),
    adjustments: t("adjustments"),
  };

  return (
    <>
      <PageHeader title={t("title")} description={t("lead")} />

      <div className="flex flex-col gap-8">
        <div className="flex flex-wrap items-center gap-2">
          <MonthPicker
            value={month}
            onChange={(next) => setUrl({ month: monthKey(next) === monthKey(thisMonth()) ? "" : monthKey(next) })}
            max={thisMonth()}
          />
          {(entities.data?.length ?? 0) > 1 ? (
            <Select
              aria-label={t("entity")}
              value={entity}
              onValueChange={(next) => setUrl({ entity: String(next ?? "") })}
              items={entityItems}
              className="min-w-56"
            />
          ) : entityName ? (
            <span className="flex items-center gap-1.5 px-1 text-kumo-subtle">
              <BuildingsIcon size={16} aria-hidden />
              {entityName}
            </span>
          ) : null}
        </div>

        <Section
          title={t("attTitle")}
          lead={t("attLead", { month: monthName })}
          link={<SeeAll href={`/timesheet?month=${key}`}>{t("attOpen", { month: monthName })}</SeeAll>}
        >
          <DataTable
            id="report-attendance"
            columns={attendanceColumns}
            rows={attendanceRows}
            keyOf={(row) => monthKey(row.at)}
            pending={attendanceRows === undefined && !attendance.some((one) => one.isError)}
            failed={attendance.some((one) => one.isError)}
            onRetry={() => attendance.forEach((one) => void one.refetch())}
            cardLead="month"
            cardTrailing="absent"
            rowHref={(row) => `/timesheet?month=${monthKey(row.at)}`}
          />
        </Section>

        <Section
          title={t("payTitle")}
          lead={entityName ? t("payLead", { month: monthName, entity: entityName }) : t("payLeadNoEntity", { month: monthName })}
          link={<SeeAll href="/payroll">{nav("payroll")}</SeeAll>}
        >
          <DataTable
            id="report-pay"
            columns={payColumns}
            rows={periodRows}
            keyOf={(row) => row.period.id}
            pending={periodRows === undefined && !periods.isError && !periodTotals.some((one) => one.isError)}
            failed={periods.isError || periodTotals.some((one) => one.isError)}
            onRetry={() => {
              void periods.refetch();
              periodTotals.forEach((one) => void one.refetch());
            }}
            empty={t("payNone")}
            cardLead="period"
            cardTrailing="cost"
            rowHref={(row) => `/payroll/${row.period.id}`}
          />
        </Section>

        <Section
          title={t("insuranceTitle")}
          lead={
            changes.data
              ? `${t("insuranceLead", { month: monthName })} ${t("unpaidRule", { days: changes.data.unpaidDayThreshold })}`
              : t("insuranceLead", { month: monthName })
          }
        >
          {entities.isError ? (
            <Failed onRetry={() => void entities.refetch()} />
          ) : entities.data?.length === 0 ? (
            <LayerCard className="p-0">
              <Empty icon={<BuildingsIcon size={40} className="text-kumo-inactive" />} title={t("noEntity")} className="py-12" />
            </LayerCard>
          ) : (
            <div className="flex flex-col gap-3">
              <FilterBar
                search={{ value: typed, onChange: setTyped, placeholder: t("searchHint") }}
                filters={[
                  {
                    key: "filing",
                    label: t("filing"),
                    value: filing,
                    onChange: (next) => setUrl({ filing: next }),
                    items: filingItems,
                    counts,
                  },
                ]}
              />
              <DataTable
                id="report-insurance"
                columns={changeColumns}
                rows={picked?.slice(0, shown)}
                keyOf={(row) => `${row.employeeId}-${row.reason}-${row.effectiveFrom}`}
                pending={changes.isPending && entity !== ""}
                failed={changes.isError}
                onRetry={() => void changes.refetch()}
                empty={url.q ? t("noneMatch") : t("noneInMonth")}
                cardLead="who"
                cardTrailing="reason"
                rowHref={(row) => `/employees/${row.employeeId}`}
                paging={
                  picked && picked.length > kPage
                    ? {
                        shown: Math.min(shown, picked.length),
                        total: picked.length,
                        onMore: picked.length > shown ? () => setShown((held) => held + kPage) : undefined,
                      }
                    : undefined
                }
              />
            </div>
          )}
        </Section>

        <Section title={t("filesTitle")} lead={t("filesLead")}>
          <div className={cn("grid gap-4", mayRollUp && "lg:grid-cols-2")}>
            <LayerCard>
              <LayerCard.Secondary>{t("d02Title")}</LayerCard.Secondary>
              <LayerCard.Primary className="gap-3">
                <p className="text-pretty text-kumo-subtle">
                  {t("d02Lead")} {entityName ? t("d02For", { name: entityName }) : null}
                </p>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="w-full sm:w-56">
                    <DateField label={t("d02On")} value={on} onChange={setOn} />
                  </div>
                  <Button
                    variant="secondary"
                    icon={DownloadSimpleIcon}
                    loading={d02.isPending}
                    disabled={entity === "" || on === ""}
                    onClick={() => d02.mutate()}
                  >
                    {t("d02Get")}
                  </Button>
                </div>
              </LayerCard.Primary>
            </LayerCard>
            {mayRollUp ? (
              <LayerCard>
                <LayerCard.Secondary>{t("rollUpTitle")}</LayerCard.Secondary>
                <LayerCard.Primary className="gap-3">
                  <p className="text-pretty text-kumo-subtle">{t("rollUpLead", { month: monthName })}</p>
                  <Button
                    variant="secondary"
                    icon={ArrowsClockwiseIcon}
                    loading={rollUp.isPending}
                    onClick={() => rollUp.mutate()}
                    className="self-start"
                  >
                    {t("rollUpRun", { month: monthName })}
                  </Button>
                </LayerCard.Primary>
              </LayerCard>
            ) : null}
          </div>
        </Section>
      </div>
    </>
  );
}

export default function ReportsPage() {
  return (
    <Suspense>
      <Reports />
    </Suspense>
  );
}
