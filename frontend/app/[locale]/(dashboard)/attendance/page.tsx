"use client";

import { Button } from "@cloudflare/kumo";
import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { MonthPicker, thisMonth, type Month } from "@/components/ui/month-picker";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { api } from "@/lib/api";

const PAGE = 50;

interface TallyPage {
  rows: Tally[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
}

interface Tally {
  employeeId: number;
  code?: string;
  fullName: string;
  punches: number;
  firstAt: string | null;
  lastAt: string | null;
  unsyncedClock: number;
}

function monthKey(at: Month): string {
  return `${at.year}-${String(at.month).padStart(2, "0")}`;
}

// The roll-up counts up to `to` inclusive, and the monthly job warms exactly this span.
function monthBounds(at: Month): { from: string; to: string } {
  const start = new Date(at.year, at.month - 1, 1);
  const end = new Date(new Date(at.year, at.month, 1).getTime() - 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export default function AttendancePage() {
  const t = useTranslations("attendance");
  const common = useTranslations("common");
  const format = useFormatter();
  const notify = useNotify();
  const [month, setMonth] = useState<Month>(thisMonth);
  const [typed, setTyped] = useState("");
  const search = useSettled(typed.trim());
  const span = monthBounds(month);
  const monthName = format.dateTime(new Date(month.year, month.month - 1, 15), { month: "long", year: "numeric" });

  // The name filter goes to the roll-up, which pages: filtering here would only search the rows on screen.
  function query(cursor: string): string {
    const params = new URLSearchParams({ from: span.from, to: span.to, take: String(PAGE) });
    if (search) {
      params.set("search", search);
    }
    if (cursor) {
      params.set("cursor", cursor);
    }
    return params.toString();
  }

  const rollup = useInfiniteQuery({
    queryKey: ["attendance", "rollup", span.from, search],
    initialPageParam: "",
    queryFn: async ({ pageParam }) => (await api.get<TallyPage>(`/reports/attendance?${query(pageParam)}`)).data,
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const totals = useQuery({
    queryKey: ["attendance", "rollup", "totals", span.from, search],
    queryFn: async () => {
      const params = new URLSearchParams({ from: span.from, to: span.to });
      if (search) {
        params.set("search", search);
      }
      return (await api.get<{ people: number; punches: number; unsyncedClock: number }>(`/reports/attendance/totals?${params.toString()}`)).data;
    },
  });

  const shown = rollup.data?.pages.flatMap((one) => one.rows);
  const first = rollup.data?.pages[0];
  const punches = totals.data?.punches ?? 0;
  const unsynced = totals.data?.unsyncedClock ?? 0;

  function clock(iso: string | null) {
    return iso ? <span className="whitespace-nowrap tabular-nums">{format.dateTime(new Date(iso), "medium")}</span> : common("empty");
  }

  // A file holds the whole month, not the pages a reader happened to open.
  const exportCsv = useMutation({
    mutationFn: async () => {
      const all: Tally[] = [];
      let cursor = "";
      for (;;) {
        const page = (await api.get<TallyPage>(`/reports/attendance?${query(cursor)}`)).data;
        all.push(...page.rows);
        if (!page.next) {
          break;
        }
        cursor = page.next;
      }
      return all;
    },
    onSuccess: (all) => {
      const head = [t("code"), t("employee"), t("punches"), t("firstAt"), t("lastAt"), t("clockOff")];
      const body = all.map((row) =>
        [row.code ?? "", row.fullName, row.punches, row.firstAt ?? "", row.lastAt ?? "", row.unsyncedClock].map(csvCell).join(","),
      );
      // Excel reads a CSV as the system codepage unless it opens with a BOM, which garbles Vietnamese names.
      const blob = new Blob(["﻿", [head.map(csvCell).join(","), ...body].join("\r\n")], {
        type: "text/csv;charset=utf-8",
      });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `attendance-${monthKey(month)}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
      notify.done(t("exported", { count: all.length }));
    },
    onError: notify.failed,
  });

  const columns: Column<Tally>[] = [
    {
      id: "employee",
      header: t("employee"),
      sticky: true,
      sortBy: (row) => row.fullName,
      cell: (row) => (
        <span className="flex flex-col">
          <span>{row.fullName}</span>
          {row.code ? <span className="font-mono text-sm text-kumo-subtle">{row.code}</span> : null}
        </span>
      ),
    },
    { id: "punches", header: t("punches"), numeric: true, sortBy: (row) => row.punches, cell: (row) => row.punches },
    {
      id: "unsyncedClock",
      header: t("clockOff"),
      numeric: true,
      sortBy: (row) => row.unsyncedClock,
      cell: (row) =>
        row.unsyncedClock > 0 ? <span className="text-kumo-warning">{row.unsyncedClock}</span> : <span className="text-kumo-subtle">0</span>,
    },
    { id: "firstAt", header: t("firstAt"), sortBy: (row) => row.firstAt ?? "", cell: (row) => clock(row.firstAt) },
    { id: "lastAt", header: t("lastAt"), sortBy: (row) => row.lastAt ?? "", cell: (row) => clock(row.lastAt) },
  ];

  const ready = totals.data !== undefined;

  return (
    <>
      <PageHeader title={t("rollupTitle")} description={t("rollupLead")} />

      <PageLayout
        aside={
          <AsideCard title={t("inMonth", { month: monthName })}>
            <Facts
              rows={[
                [
                  t("people"),
                  totals.data ? <span className="tabular-nums">{totals.data.people}</span> : common("empty"),
                ],
                [t("punchesTotal"), ready ? <span className="tabular-nums">{punches}</span> : common("empty")],
                [
                  t("clockOff"),
                  ready ? <span className={unsynced > 0 ? "text-kumo-warning tabular-nums" : "tabular-nums"}>{unsynced}</span> : common("empty"),
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
          extra={<MonthPicker value={month} onChange={setMonth} max={thisMonth()} />}
        />
        <DataTable
          id="attendance-rollup"
          cardLead="employee"
          columns={columns}
          rows={shown}
          keyOf={(row) => String(row.employeeId)}
          pending={rollup.isPending}
          failed={rollup.isError}
          onRetry={() => void rollup.refetch()}
          rowHref={(row) => `/attendance/${row.employeeId}?month=${monthKey(month)}`}
          empty={search ? t("noMatch") : t("monthEmpty")}
          emptyHint={search ? t("noMatchHint") : undefined}
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
