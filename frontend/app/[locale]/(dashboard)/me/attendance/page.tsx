"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";

import { DataTable, type Column } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";

const PAGE = 50;

interface PunchPage {
  rows: Punch[];
  total: number;
  next: string | null;
}

interface Punch {
  id: string;
  deviceId: string;
  ts: string;
  direction: "IN" | "OUT";
  doorOpened: boolean;
  capturedOffline: boolean;
  clockUnsynced: boolean;
}

export default function MyAttendancePage() {
  const t = useTranslations("attendance");
  const me = useTranslations("me");
  const nav = useTranslations("nav");
  const common = useTranslations("common");
  const format = useFormatter();
  const employeeId = useSession((s) => s.employeeId);

  const punches = useInfiniteQuery({
    queryKey: ["attendance", "mine", employeeId],
    enabled: employeeId !== null,
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const after = pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : "";
      return (
        await api.get<PunchPage>(`/attendance?employeeId=${employeeId}&take=${PAGE}${after}`)
      ).data;
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
      id: "flags",
      header: t("flags"),
      cell: (row) =>
        row.clockUnsynced ? (
          <span className="text-(--color-warn)">{t("flagClock")}</span>
        ) : (
          <span className="text-(--color-muted)">{common("empty")}</span>
        ),
    },
  ];

  if (employeeId === null) {
    return <p className="text-sm text-(--color-muted)">{me("noProfile")}</p>;
  }

  return (
    <section>
      <h1 className="text-lg font-semibold">{nav("myAttendance")}</h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">{t("lead")}</p>
      <DataTable
        id="my-attendance"
        columns={columns}
        rows={rows}
        keyOf={(row) => row.id}
        pending={punches.isPending}
        failed={punches.isError}
        onRetry={() => punches.refetch()}
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
