"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useParams } from "next/navigation";

import { DataTable, type Column } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
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
}

const PAGE = 50;

export default function PunchHistoryPage() {
  const t = useTranslations("attendance");
  const common = useTranslations("common");
  const format = useFormatter();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);

  const employee = useQuery({
    queryKey: ["employees", id],
    queryFn: async () => (await api.get<Employee>(`/employees/${id}`)).data,
  });

  const punches = useInfiniteQuery({
    queryKey: ["attendance", "punches", id],
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const after = pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : "";
      return (await api.get<PunchPage>(`/attendance?employeeId=${id}&take=${PAGE}${after}`)).data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const rows = punches.data?.pages.flatMap((one) => one.rows);
  const counted = punches.data?.pages[0];

  const columns: Column<Punch>[] = [
    {
      id: "at",
      header: t("at"),
      sticky: true,
      sortBy: (row) => row.ts,
      cell: (row) => format.dateTime(new Date(row.ts), "medium"),
    },
    {
      id: "direction",
      header: t("direction"),
      cell: (row) => t(`direction${row.direction}`),
    },
    {
      id: "deviceCol",
      header: t("deviceCol"),
      cell: (row) => <span className="font-mono text-xs">{row.deviceId}</span>,
    },
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
      cell: (row) => {
        const marks: string[] = [];
        if (row.doorOpened) {
          marks.push(t("flagDoor"));
        }
        if (row.capturedOffline) {
          marks.push(t("flagOffline"));
        }
        if (row.clockUnsynced) {
          marks.push(t("flagClock"));
        }
        return marks.length === 0 ? (
          <span className="text-(--color-muted)">{common("empty")}</span>
        ) : (
          <span className={row.clockUnsynced ? "text-(--color-warn)" : "text-(--color-muted)"}>
            {marks.join(" · ")}
          </span>
        );
      },
    },
  ];

  return (
    <section>
      <h1 className="mt-2 text-lg font-semibold">
        {employee.data?.fullName ?? t("historyTitle")}
      </h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">
        {counted
          ? t(counted.totalIsExact === false ? "ofPunchesAtLeast" : "ofPunches", {
              count: counted.total,
            })
          : " "}
      </p>
      <DataTable
        id="employee-attendance"
        columns={columns}
        rows={rows}
        keyOf={(row) => row.id}
        failed={punches.isError}
        onRetry={() => punches.refetch()}
        pending={punches.isPending}
        empty={t("historyEmpty")}
        more={
          punches.hasNextPage ? (
            <div className="mt-3 flex flex-col items-center gap-1">
              <Button
                type="button"
                tone="quiet"
                disabled={punches.isFetchingNextPage}
                onClick={() => void punches.fetchNextPage()}
              >
                {punches.isFetchingNextPage ? common("loading") : common("loadMore")}
              </Button>
              <p className="text-xs text-(--color-muted) tabular-nums">
                {common("showingOf", { shown: rows?.length ?? 0, total: counted?.total ?? 0 })}
              </p>
            </div>
          ) : null
        }
      />
    </section>
  );
}
