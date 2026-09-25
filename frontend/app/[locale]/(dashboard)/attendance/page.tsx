"use client";

import { Button } from "@cloudflare/kumo";
import { DownloadSimpleIcon, XIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { Suspense, useEffect, useState } from "react";

import { DataTable, PersonCell, type Column } from "@/components/tables/data-table";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { MonthPicker, thisMonth, type Month } from "@/components/ui/month-picker";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { api } from "@/lib/api";
import { dayOnly } from "@/lib/format";
import { useUrlState } from "@/lib/url-state";

const PAGE = 50;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^(\d{4})-(\d{2})$/;

interface TallyPage {
  rows: Tally[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
}

interface Tally {
  employeeId: number;
  code: string;
  fullName: string;
  punches: number;
  firstAt: string | null;
  lastAt: string | null;
  unsyncedClock: number;
}

interface Department {
  id: string;
  name: string;
}

function monthOf(raw: string): Month {
  const hit = raw.match(MONTH);
  const month = hit ? Number(hit[2]) : 0;
  return hit && month >= 1 && month <= 12 ? { year: Number(hit[1]), month } : thisMonth();
}

function monthKey(at: Month): string {
  return `${at.year}-${String(at.month).padStart(2, "0")}`;
}

// The roll-up counts up to `to` inclusive, and the monthly job warms exactly a month's span.
function monthBounds(at: Month): { from: string; to: string } {
  const start = new Date(at.year, at.month - 1, 1);
  const end = new Date(new Date(at.year, at.month, 1).getTime() - 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function dayBounds(from: string, to: string): { from: string; to: string } {
  const start = dayOnly(from);
  const end = dayOnly(to);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: new Date(end.getTime() - 1).toISOString() };
}

// Excel runs a cell opening with = + - @ tab or CR as a formula, a plain number aside (KEHOACH 7.2).
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

function csvCell(value: string | number): string {
  const held = String(value);
  const text = FORMULA_LEAD.test(held) && !PLAIN_NUMBER.test(held) ? `'${held}` : held;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function Attendance() {
  const t = useTranslations("attendance");
  const common = useTranslations("common");
  const format = useFormatter();
  const notify = useNotify();

  const [url, setUrl] = useUrlState({ q: "", departmentId: "", month: "", from: "", to: "", show: "" });
  const [typed, setTyped] = useState(url.q);
  const settled = useSettled(typed.trim());
  useEffect(() => {
    if (settled !== url.q) {
      setUrl({ q: settled });
    }
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps

  const month = monthOf(url.month);
  // A link from the home page names days; picking a month goes back to whole months.
  const ranged = DAY.test(url.from) && DAY.test(url.to);
  const span = ranged ? dayBounds(url.from, url.to) : monthBounds(month);
  const spanName = ranged
    ? url.from === url.to
      ? format.dateTime(dayOnly(url.from), "day")
      : `${format.dateTime(dayOnly(url.from), "day")} – ${format.dateTime(dayOnly(url.to), "day")}`
    : format.dateTime(new Date(month.year, month.month - 1, 15), { month: "long", year: "numeric" });

  function filtered(): URLSearchParams {
    const params = new URLSearchParams({ from: span.from, to: span.to });
    if (url.q) {
      params.set("search", url.q);
    }
    if (url.departmentId) {
      params.set("departmentId", url.departmentId);
    }
    if (url.show === "late") {
      params.set("late", "true");
    }
    return params;
  }
  const filter = filtered();

  function page(cursor: string): string {
    const params = new URLSearchParams(filter);
    params.set("take", String(PAGE));
    if (cursor) {
      params.set("cursor", cursor);
    }
    return params.toString();
  }

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Department[]>("/departments")).data,
  });

  const rollup = useInfiniteQuery({
    queryKey: ["attendance", "rollup", filter.toString()],
    initialPageParam: "",
    queryFn: async ({ pageParam }) => (await api.get<TallyPage>(`/reports/attendance?${page(pageParam)}`)).data,
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const totals = useQuery({
    queryKey: ["attendance", "rollup", "totals", filter.toString()],
    queryFn: async () =>
      (await api.get<{ people: number; punches: number; unsyncedClock: number }>(`/reports/attendance/totals?${filter.toString()}`)).data,
  });

  const shown = rollup.data?.pages.flatMap((one) => one.rows);
  const first = rollup.data?.pages[0];
  const punches = totals.data?.punches ?? 0;
  const unsynced = totals.data?.unsyncedClock ?? 0;

  function clock(iso: string | null) {
    return iso ? <span className="whitespace-nowrap tabular-nums">{format.dateTime(new Date(iso), "medium")}</span> : common("empty");
  }

  // A file holds the whole filter, not the pages a reader happened to open.
  const exportCsv = useMutation({
    mutationFn: async () => {
      const all: Tally[] = [];
      let cursor = "";
      for (;;) {
        const one = (await api.get<TallyPage>(`/reports/attendance?${page(cursor)}`)).data;
        all.push(...one.rows);
        if (!one.next) {
          break;
        }
        cursor = one.next;
      }
      return all;
    },
    onSuccess: (all) => {
      const head = [t("code"), t("employee"), t("punches"), t("firstAt"), t("lastAt"), t("clockOff")];
      const body = all.map((row) =>
        [row.code, row.fullName, row.punches, row.firstAt ?? "", row.lastAt ?? "", row.unsyncedClock].map(csvCell).join(","),
      );
      // Excel reads a CSV as the system codepage unless it opens with a BOM, which garbles Vietnamese names.
      const blob = new Blob(["﻿", [head.map(csvCell).join(","), ...body].join("\r\n")], {
        type: "text/csv;charset=utf-8",
      });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `attendance-${ranged ? `${url.from}-${url.to}` : monthKey(month)}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
      notify.done(t("exported", { count: all.length }));
    },
    onError: notify.failed,
  });

  const columns: Column<Tally>[] = [
    { id: "employee", header: t("employee"), cell: (row) => <PersonCell name={row.fullName} code={row.code} /> },
    { id: "punches", header: t("punches"), numeric: true, cell: (row) => row.punches },
    {
      id: "unsyncedClock",
      header: t("clockOff"),
      numeric: true,
      priority: 2,
      cell: (row) =>
        row.unsyncedClock > 0 ? <span className="text-kumo-warning">{row.unsyncedClock}</span> : <span className="text-kumo-subtle">0</span>,
    },
    { id: "firstAt", header: t("firstAt"), priority: 3, cell: (row) => clock(row.firstAt) },
    { id: "lastAt", header: t("lastAt"), priority: 3, cell: (row) => clock(row.lastAt) },
  ];

  const ready = totals.data !== undefined;
  const narrowed = url.q !== "" || url.departmentId !== "" || url.show !== "";
  const departmentItems: Record<string, string> = {
    "": t("allDepartments"),
    ...Object.fromEntries((departments.data ?? []).map((one) => [one.id, one.name])),
  };
  const rowMonth = ranged ? url.from.slice(0, 7) : monthKey(month);

  return (
    <>
      <PageHeader title={t("rollupTitle")} description={t("rollupLead")} />

      <PageLayout
        aside={
          <AsideCard title={t("inMonth", { month: spanName })}>
            <Facts
              rows={[
                [t("people"), totals.data ? <span className="tabular-nums">{format.number(totals.data.people)}</span> : common("empty")],
                [t("punchesTotal"), ready ? <span className="tabular-nums">{format.number(punches)}</span> : common("empty")],
                [
                  t("clockOff"),
                  ready ? (
                    <span className={unsynced > 0 ? "text-kumo-warning tabular-nums" : "tabular-nums"}>{format.number(unsynced)}</span>
                  ) : (
                    common("empty")
                  ),
                ],
              ]}
            />
            <p className="mt-3 text-sm text-kumo-subtle">{t("unsyncedHint")}</p>
          </AsideCard>
        }
        extra={
          <AsideCard title={common("tools")}>
            <Button
              variant="secondary"
              icon={DownloadSimpleIcon}
              loading={exportCsv.isPending}
              disabled={!shown || shown.length === 0}
              onClick={() => exportCsv.mutate()}
              className="w-full justify-start"
            >
              {t("exportMonth")}
            </Button>
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
              key: "show",
              label: t("showLabel"),
              value: url.show,
              onChange: (value) => setUrl({ show: value }),
              items: { "": t("showAll"), late: t("showLate") },
            },
          ]}
          extra={
            ranged ? (
              <Button variant="secondary" icon={XIcon} onClick={() => setUrl({ from: "", to: "" })}>
                {spanName}
              </Button>
            ) : (
              <MonthPicker value={month} onChange={(next) => setUrl({ month: monthKey(next) === monthKey(thisMonth()) ? "" : monthKey(next) })} max={thisMonth()} />
            )
          }
        />
        <DataTable
          id="attendance-rollup"
          cardLead="employee"
          cardTrailing="punches"
          columns={columns}
          rows={shown}
          keyOf={(row) => String(row.employeeId)}
          pending={rollup.isPending}
          failed={rollup.isError}
          onRetry={() => void rollup.refetch()}
          rowHref={(row) => `/attendance/${row.employeeId}?month=${rowMonth}`}
          empty={narrowed ? t("noMatch") : t("monthEmpty")}
          emptyHint={narrowed ? t("noMatchHint") : undefined}
          paging={
            first
              ? {
                  shown: shown?.length ?? 0,
                  total: first.total,
                  exact: first.totalIsExact,
                  onMore: rollup.hasNextPage ? () => void rollup.fetchNextPage() : undefined,
                  loading: rollup.isFetchingNextPage,
                }
              : undefined
          }
        />
      </PageLayout>
    </>
  );
}

export default function AttendancePage() {
  return (
    <Suspense>
      <Attendance />
    </Suspense>
  );
}
