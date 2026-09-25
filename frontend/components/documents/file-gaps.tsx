"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { DataTable, type Column } from "@/components/tables/data-table";
import { api } from "@/lib/api";

interface Named {
  typeId: string;
  code: string;
  name: string;
}

interface GapPage {
  rows: Gap[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
}

interface Gap {
  employeeId: number;
  code: string;
  fullName: string;
  missing: Named[];
  expired: (Named & { expiresAt: string })[];
}

/** Who is short of a required paper. A subtraction, so it needs no upkeep. */
export function FileGaps() {
  const t = useTranslations("documents");
  const common = useTranslations("common");

  const gaps = useInfiniteQuery({
    queryKey: ["personnel-files", "gaps"],
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const after = pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : "";
      return (await api.get<GapPage>(`/personnel-files/gaps${after}`)).data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const rows = gaps.data?.pages.flatMap((one) => one.rows);
  const first = gaps.data?.pages[0];

  const columns: Column<Gap>[] = [
    {
      id: "person",
      header: t("person"),
      sticky: true,
      sortBy: (row) => row.fullName,
      cell: (row) => (
        <span className="flex flex-col">
          <span>{row.fullName}</span>
          <span className="font-mono text-sm text-kumo-subtle">{row.code}</span>
        </span>
      ),
    },
    {
      id: "missing",
      header: t("missing"),
      sortBy: (row) => row.missing.length,
      cell: (row) => (row.missing.length > 0 ? row.missing.map((one) => one.name).join(", ") : common("empty")),
    },
    {
      id: "expired",
      header: t("expired"),
      sortBy: (row) => row.expired.length,
      cell: (row) =>
        row.expired.length > 0 ? (
          <span className="text-kumo-warning">{row.expired.map((one) => one.name).join(", ")}</span>
        ) : (
          common("empty")
        ),
    },
  ];

  return (
    <DataTable
      id="file-gaps"
      cardLead="person"
      columns={columns}
      rows={rows}
      keyOf={(row) => String(row.employeeId)}
      pending={gaps.isPending}
      failed={gaps.isError}
      onRetry={() => void gaps.refetch()}
      empty={t("noGaps")}
      emptyHint={t("noGapsHint")}
      rowHref={(row) => `/employees/${row.employeeId}?tab=files`}
      paging={
        first && first.total > 0
          ? {
              shown: rows?.length ?? 0,
              total: first.total,
              exact: first.totalIsExact,
              onMore: gaps.hasNextPage ? () => void gaps.fetchNextPage() : undefined,
              loading: gaps.isFetchingNextPage,
            }
          : undefined
      }
    />
  );
}
