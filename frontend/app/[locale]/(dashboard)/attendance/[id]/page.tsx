"use client";

import { SkeletonLine } from "@cloudflare/kumo";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useParams, useSearchParams } from "next/navigation";
import { useState } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { FilterBar } from "@/components/ui/filter-bar";
import { MonthPicker, thisMonth, type Month } from "@/components/ui/month-picker";
import { AsideCard, Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill } from "@/components/ui/pill";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";

interface PunchPage {
  rows: Punch[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
}

interface Punch {
  id: string;
  localId: string;
  deviceId: string;
  ts: string;
  direction: "IN" | "OUT";
  score: number | null;
  doorOpened: boolean;
  capturedOffline: boolean;
  clockUnsynced: boolean;
}

interface Employee {
  id: number;
  code: string;
  fullName: string;
  department: { id: string; name: string } | null;
}

const PAGE = 200;

function monthFrom(raw: string | null): Month {
  const hit = raw?.match(/^(\d{4})-(\d{2})$/);
  if (!hit) {
    return thisMonth();
  }
  const month = Number(hit[2]);
  return month >= 1 && month <= 12 ? { year: Number(hit[1]), month } : thisMonth();
}

export default function PunchHistoryPage() {
  const t = useTranslations("attendance");
  const common = useTranslations("common");
  const format = useFormatter();
  const params = useParams<{ id: string }>();
  const asked = useSearchParams().get("month");
  const id = Number(params.id);
  const [month, setMonth] = useState<Month>(() => monthFrom(asked));
  const monthName = format.dateTime(new Date(month.year, month.month - 1, 15), { month: "long", year: "numeric" });
  const from = new Date(month.year, month.month - 1, 1).toISOString();
  const to = new Date(month.year, month.month, 1).toISOString();

  const employee = useQuery({
    queryKey: ["employees", id],
    queryFn: async () => (await api.get<Employee>(`/employees/${id}`)).data,
  });

  const punches = useInfiniteQuery({
    queryKey: ["attendance", "punches", id, from],
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const query = new URLSearchParams({ employeeId: String(id), from, to, take: String(PAGE) });
      if (pageParam) {
        query.set("cursor", pageParam);
      }
      return (await api.get<PunchPage>(`/attendance?${query.toString()}`)).data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

  // The total of a one-row page filtered on a flag is that flag's count over the whole month.
  const flagged = useQueries({
    queries: (["capturedOffline", "clockUnsynced"] as const).map((flag) => ({
      queryKey: ["attendance", "punches", id, from, flag],
      queryFn: async () => {
        const query = new URLSearchParams({ employeeId: String(id), from, to, take: "1", [flag]: "true" });
        return (await api.get<PunchPage>(`/attendance?${query.toString()}`)).data.total;
      },
    })),
  });

  const rows = punches.data?.pages.flatMap((one) => one.rows);
  const first = punches.data?.pages[0];
  const offline = flagged[0].data;
  const unsynced = flagged[1].data;
  const person = employee.data;

  const columns: Column<Punch>[] = [
    {
      id: "at",
      header: t("at"),
      sticky: true,
      sortBy: (row) => row.ts,
      cell: (row) => <span className="whitespace-nowrap tabular-nums">{format.dateTime(new Date(row.ts), "medium")}</span>,
    },
    { id: "direction", header: t("direction"), sortBy: (row) => row.direction, cell: (row) => t(`direction${row.direction}`) },
    { id: "deviceCol", header: t("deviceCol"), sortBy: (row) => row.deviceId, cell: (row) => <span className="font-mono text-sm">{row.deviceId}</span> },
    {
      id: "score",
      header: t("score"),
      numeric: true,
      sortBy: (row) => row.score ?? -1,
      cell: (row) => (row.score === null ? common("empty") : row.score.toFixed(2)),
    },
    {
      id: "flags",
      header: t("flags"),
      cell: (row) =>
        row.doorOpened || row.capturedOffline || row.clockUnsynced ? (
          <span className="flex flex-wrap gap-1">
            {row.clockUnsynced ? <StatePill tone="waiting">{t("flagClock")}</StatePill> : null}
            {row.capturedOffline ? <StatePill>{t("flagOffline")}</StatePill> : null}
            {row.doorOpened ? <StatePill>{t("flagDoor")}</StatePill> : null}
          </span>
        ) : (
          <span className="text-kumo-subtle">{common("empty")}</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader title={person?.fullName ?? t("historyTitle")} description={t("personLead")} />

      <PageLayout
        aside={
          <>
            <AsideCard
              title={t("person")}
              action={
                <Link href={`/employees/${id}`} className="text-sm font-normal text-kumo-link hover:underline">
                  {t("openProfile")}
                </Link>
              }
            >
              {person ? (
                <Facts
                  rows={[
                    [t("code"), <span className="font-mono">{person.code}</span>],
                    [t("department"), person.department?.name ?? common("empty")],
                  ]}
                />
              ) : (
                <div className="flex flex-col gap-3 py-1">
                  <SkeletonLine minWidth={25} maxWidth={35} />
                  <SkeletonLine minWidth={25} maxWidth={40} />
                </div>
              )}
            </AsideCard>
            <AsideCard title={t("inMonth", { month: monthName })}>
              <Facts
                rows={[
                  [
                    t("punchesTotal"),
                    first ? (
                      <span className="tabular-nums">{first.totalIsExact === false ? t("atLeast", { count: first.total }) : format.number(first.total)}</span>
                    ) : (
                      common("empty")
                    ),
                  ],
                  [t("offlinePunches"), offline !== undefined ? <span className="tabular-nums">{format.number(offline)}</span> : common("empty")],
                  [
                    t("clockOff"),
                    unsynced !== undefined ? (
                      <span className={unsynced > 0 ? "text-kumo-warning tabular-nums" : "tabular-nums"}>{format.number(unsynced)}</span>
                    ) : (
                      common("empty")
                    ),
                  ],
                ]}
              />
            </AsideCard>
          </>
        }
      >
        <FilterBar extra={<MonthPicker value={month} onChange={setMonth} max={thisMonth()} />} />
        <DataTable
          id="employee-attendance"
          cardLead="at"
          columns={columns}
          rows={rows}
          keyOf={(row) => row.id}
          pending={punches.isPending}
          failed={punches.isError}
          onRetry={() => void punches.refetch()}
          empty={t("personMonthEmpty")}
          paging={
            first
              ? {
                  shown: rows?.length ?? 0,
                  total: first.total,
                  exact: first.totalIsExact,
                  onMore: punches.hasNextPage ? () => void punches.fetchNextPage() : undefined,
                  loading: punches.isFetchingNextPage,
                }
              : undefined
          }
        />
      </PageLayout>
    </>
  );
}
