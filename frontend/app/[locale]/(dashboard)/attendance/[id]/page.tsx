"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { Suspense } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { FilterBar } from "@/components/ui/filter-bar";
import { MonthPicker, thisMonth, type Month } from "@/components/ui/month-picker";
import { PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill } from "@/components/ui/pill";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useUrlState } from "@/lib/url-state";

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

interface Counts {
  all: number;
  capturedOffline: number;
  clockUnsynced: number;
}

interface Kiosk {
  id: string;
  name: string | null;
}

type Flag = "" | "capturedOffline" | "clockUnsynced";

const PAGE = 200;
const MONTH = /^(\d{4})-(\d{2})$/;
// The kiosk picker is open to the enrolment desk only; everyone else reads the machine id.
const KIOSK_READERS = new Set(["ADMIN", "HR"]);

function monthOf(raw: string): Month {
  const hit = raw.match(MONTH);
  const month = hit ? Number(hit[2]) : 0;
  return hit && month >= 1 && month <= 12 ? { year: Number(hit[1]), month } : thisMonth();
}

function monthKey(at: Month): string {
  return `${at.year}-${String(at.month).padStart(2, "0")}`;
}

function PunchHistory() {
  const t = useTranslations("attendance");
  const common = useTranslations("common");
  const format = useFormatter();
  const role = useSession((s) => s.role);
  const params = useParams<{ id: string }>();
  const id = Number(params.id);

  const [url, setUrl] = useUrlState({ month: "", flag: "" });
  const month = monthOf(url.month);
  const flag = (["capturedOffline", "clockUnsynced"].includes(url.flag) ? url.flag : "") as Flag;
  const from = new Date(month.year, month.month - 1, 1).toISOString();
  const to = new Date(month.year, month.month, 1).toISOString();
  const range = new URLSearchParams({ employeeId: String(id), from, to });

  const employee = useQuery({
    queryKey: ["employees", id],
    queryFn: async () => (await api.get<Employee>(`/employees/${id}`)).data,
  });

  const kiosks = useQuery({
    queryKey: ["enrollments", "devices"],
    enabled: role !== null && KIOSK_READERS.has(role),
    queryFn: async () => (await api.get<Kiosk[]>("/enrollments/devices")).data,
  });
  const kioskName = (deviceId: string) => kiosks.data?.find((one) => one.id === deviceId)?.name ?? deviceId;

  const counts = useQuery({
    queryKey: ["attendance", "counts", range.toString()],
    queryFn: async () => (await api.get<Counts>(`/attendance/counts?${range.toString()}`)).data,
  });

  const punches = useInfiniteQuery({
    queryKey: ["attendance", "punches", range.toString(), flag],
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const query = new URLSearchParams(range);
      query.set("take", String(PAGE));
      if (flag) {
        query.set(flag, "true");
      }
      if (pageParam) {
        query.set("cursor", pageParam);
      }
      return (await api.get<PunchPage>(`/attendance?${query.toString()}`)).data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const rows = punches.data?.pages.flatMap((one) => one.rows);
  const first = punches.data?.pages[0];
  const person = employee.data;

  const columns: Column<Punch>[] = [
    {
      id: "at",
      header: t("at"),
      cell: (row) => <span className="whitespace-nowrap tabular-nums">{format.dateTime(new Date(row.ts), "medium")}</span>,
    },
    { id: "direction", header: t("direction"), cell: (row) => t(`direction${row.direction}`) },
    { id: "deviceCol", header: t("deviceCol"), priority: 2, truncate: true, cell: (row) => kioskName(row.deviceId) },
    {
      id: "score",
      header: t("score"),
      numeric: true,
      priority: 3,
      cell: (row) => (row.score === null ? common("empty") : row.score.toFixed(2)),
    },
    {
      id: "flags",
      header: t("flags"),
      priority: 2,
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
      <PageHeader
        title={person?.fullName ?? t("historyTitle")}
        description={
          person ? (
            <>
              {t("personFacts", { code: person.code, department: person.department?.name ?? common("empty") })}{" "}
              <Link href={`/employees/${id}`} className="text-kumo-link hover:underline">
                {t("openProfile")}
              </Link>
            </>
          ) : (
            t("personLead")
          )
        }
      />

      <PageLayout>
        <FilterBar
          filters={[
            {
              key: "flag",
              label: t("flags"),
              value: flag,
              onChange: (value) => setUrl({ flag: value }),
              items: { "": t("flagAll"), capturedOffline: t("offlinePunches"), clockUnsynced: t("clockOff") },
              counts: {
                "": counts.data?.all,
                capturedOffline: counts.data?.capturedOffline,
                clockUnsynced: counts.data?.clockUnsynced,
              },
            },
          ]}
          extra={
            <MonthPicker
              value={month}
              onChange={(next) => setUrl({ month: monthKey(next) === monthKey(thisMonth()) ? "" : monthKey(next) })}
              max={thisMonth()}
            />
          }
        />
        <DataTable
          id="employee-attendance"
          cardLead="at"
          cardTrailing="direction"
          columns={columns}
          rows={rows}
          keyOf={(row) => row.id}
          pending={punches.isPending}
          failed={punches.isError}
          onRetry={() => void punches.refetch()}
          empty={flag ? common("noMatch") : t("personMonthEmpty")}
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

export default function PunchHistoryPage() {
  return (
    <Suspense>
      <PunchHistory />
    </Suspense>
  );
}
