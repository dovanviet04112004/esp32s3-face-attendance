"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import {
  StatePill,
  type RequestKind,
  type RequestRow,
  type RequestState,
} from "@/components/requests/request-card";
import { FilterBar } from "@/components/ui/filter-bar";
import { AsideCard, PageHeader, PageLayout, StatList } from "@/components/ui/page";
import { api } from "@/lib/api";
import { dayOnly, days, minutes } from "@/lib/format";

const STATES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const;
const KINDS: RequestKind[] = ["LEAVE", "OVERTIME", "ATTENDANCE_FIX", "BUSINESS_TRIP", "REMOTE_WORK"];
const kPage = 50;

interface RequestPage {
  rows: RequestRow[];
  total: number;
}

function query(params: Record<string, string>): string {
  const kept = Object.entries(params).filter(([, value]) => value !== "");
  return kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
}

export default function RequestRegisterPage() {
  const t = useTranslations("requests");
  const common = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();
  // Every state by default: filtering to pending here would repeat the
  // approvals inbox under a second sidebar entry (KEHOACH 9.15).
  const [state, setState] = useState<RequestState | "">("");
  const [kind, setKind] = useState<RequestKind | "">("");

  const rows = useInfiniteQuery({
    queryKey: ["requests", "desk", state, kind],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      (await api.get<RequestPage>(`/requests${query({ state, kind, skip: String(pageParam), take: String(kPage) })}`)).data,
    getNextPageParam: (last, pages) => {
      const seen = pages.reduce((total, one) => total + one.rows.length, 0);
      return seen < last.total ? seen : undefined;
    },
  });

  // Totals only: one row asked per state, the count read off the page.
  const counts = useQuery({
    queryKey: ["requests", "desk", "counts", kind],
    queryFn: async () => {
      const count = async (one: string) =>
        (await api.get<RequestPage>(`/requests${query({ state: one, kind, take: "1" })}`)).data.total;
      const [all, ...each] = await Promise.all([count(""), ...STATES.map(count)]);
      return { all, each: Object.fromEntries(STATES.map((one, at) => [one, each[at] ?? 0])) as Record<string, number> };
    },
  });

  function span(row: RequestRow): string {
    const to = format.dateTime(dayOnly(row.toDate), { day: "numeric", month: "numeric", year: "numeric" });
    const sameYear = row.fromDate.slice(0, 4) === row.toDate.slice(0, 4);
    const from = format.dateTime(dayOnly(row.fromDate), sameYear ? { day: "numeric", month: "numeric" } : { day: "numeric", month: "numeric", year: "numeric" });
    return row.fromDate === row.toDate ? to : `${from} → ${to}`;
  }

  const shown = rows.data?.pages.flatMap((one) => one.rows);
  const total = rows.data?.pages[0]?.total;
  const filtered = state !== "" || kind !== "";

  const columns: Column<RequestRow>[] = [
    {
      id: "who",
      header: t("who"),
      sticky: true,
      sortBy: (row) => row.employee?.fullName ?? "",
      cell: (row) => (
        <span className="whitespace-nowrap">
          {row.employee ? row.employee.fullName : t(`kind${row.kind}`)}
          {row.employee ? <span className="ms-2 font-mono text-sm text-kumo-subtle">{row.employee.code}</span> : null}
        </span>
      ),
    },
    { id: "state", header: t("state"), sortBy: (row) => row.state, cell: (row) => <StatePill state={row.state} /> },
    {
      id: "kind",
      header: t("kind"),
      sortBy: (row) => row.kind,
      cell: (row) => (
        <span className="whitespace-nowrap">
          {row.leaveType ? row.leaveType.name : t(`kind${row.kind}`)}
          {row.minutes > 0 ? ` · ${minutes(row.minutes, locale)}` : ""}
        </span>
      ),
    },
    {
      id: "range",
      header: t("range"),
      sortBy: (row) => row.fromDate,
      cell: (row) => <span className="whitespace-nowrap">{span(row)}</span>,
    },
    { id: "days", header: t("days"), numeric: true, sortBy: (row) => Number(row.days), cell: (row) => days(Number(row.days), locale) },
    {
      id: "reason",
      header: t("reason"),
      sortBy: (row) => row.reason,
      cell: (row) => <span className="block max-w-48 truncate">{row.reason}</span>,
    },
  ];

  return (
    <>
      <PageHeader title={t("registerTitle")} description={t("deskLead")} />

      <PageLayout
        aside={
          <AsideCard title={t("byState")}>
            <StatList
              stats={[
                ...STATES.map((one) => ({
                  key: one,
                  label: t(`count${one}`),
                  value: counts.data?.each[one] ?? common("empty"),
                  active: state === one,
                  tone: one === "PENDING" && (counts.data?.each[one] ?? 0) > 0 ? ("warning" as const) : undefined,
                  onPick: () => setState(one),
                })),
                {
                  key: "all",
                  label: common("all"),
                  value: counts.data?.all ?? common("empty"),
                  active: state === "",
                  onPick: () => setState(""),
                },
              ]}
            />
          </AsideCard>
        }
      >
        <FilterBar
          filters={[
            {
              key: "kind",
              label: t("kind"),
              value: kind,
              onChange: (next) => setKind(next as RequestKind | ""),
              items: { "": t("anyKind"), ...Object.fromEntries(KINDS.map((one) => [one, t(`kind${one}`)])) },
            },
            {
              key: "state",
              label: t("state"),
              value: state,
              onChange: (next) => setState(next as RequestState | ""),
              items: { "": t("anyState"), ...Object.fromEntries(STATES.map((one) => [one, t(`count${one}`)])) },
            },
          ]}
        />
        <DataTable
          id="requests"
          cardLead="who"
          columns={columns}
          rows={shown}
          keyOf={(row) => row.id}
          pending={rows.isPending}
          failed={rows.isError}
          onRetry={() => void rows.refetch()}
          rowHref={(row) => `/leave/${row.id}`}
          empty={filtered ? t("registerNoMatch") : t("registerEmpty")}
          emptyHint={filtered ? t("registerNoMatchHint") : undefined}
          paging={
            total !== undefined
              ? {
                  shown: shown?.length ?? 0,
                  total,
                  onMore: rows.hasNextPage ? () => void rows.fetchNextPage() : undefined,
                  loading: rows.isFetchingNextPage,
                }
              : undefined
          }
        />
      </PageLayout>
    </>
  );
}
