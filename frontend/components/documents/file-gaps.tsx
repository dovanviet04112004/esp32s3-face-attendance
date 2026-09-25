"use client";

import { Button, Empty, LayerCard } from "@cloudflare/kumo";
import { FilesIcon, PlusIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { DataTable, PersonCell, type Column } from "@/components/tables/data-table";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { api } from "@/lib/api";
import { useUrlState } from "@/lib/url-state";

interface Department {
  id: string;
  code: string;
  name: string;
}

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

/** Who is short of a required paper. A subtraction, so it needs no upkeep.
 *  Its search and department filter sit in the page URL beside the page's own.
 *  @param declared whether any active type is required; without one nobody can be short
 */
export function FileGaps({ declared, onDeclare }: { declared: boolean | undefined; onDeclare: () => void }) {
  const t = useTranslations("documents");
  const common = useTranslations("common");

  const [url, setUrl] = useUrlState({ gq: "", gdept: "" });
  const [typed, setTyped] = useState(url.gq);
  const settled = useSettled(typed.trim());
  useEffect(() => {
    if (settled !== url.gq) {
      setUrl({ gq: settled });
    }
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Department[]>("/departments")).data,
  });

  const filters = new URLSearchParams({
    ...(url.gq ? { search: url.gq } : {}),
    ...(url.gdept ? { departmentId: url.gdept } : {}),
  }).toString();
  const gaps = useInfiniteQuery({
    queryKey: ["personnel-files", "gaps", filters],
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const query = new URLSearchParams(filters);
      if (pageParam) {
        query.set("cursor", pageParam);
      }
      const text = query.toString();
      return (await api.get<GapPage>(`/personnel-files/gaps${text ? `?${text}` : ""}`)).data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const rows = gaps.data?.pages.flatMap((one) => one.rows);
  const first = gaps.data?.pages[0];
  const filtering = url.gq !== "" || url.gdept !== "";

  const columns: Column<Gap>[] = [
    { id: "person", header: t("person"), cell: (row) => <PersonCell name={row.fullName} code={row.code} /> },
    {
      id: "missing",
      header: t("missing"),
      truncate: true,
      cell: (row) => (row.missing.length > 0 ? row.missing.map((one) => one.name).join(", ") : common("empty")),
    },
    {
      id: "expired",
      header: t("expired"),
      priority: 2,
      truncate: true,
      cell: (row) =>
        row.expired.length > 0 ? (
          <span className="text-kumo-warning">{row.expired.map((one) => one.name).join(", ")}</span>
        ) : (
          common("empty")
        ),
    },
  ];

  if (declared === false) {
    return (
      <LayerCard className="p-0">
        <Empty
          icon={<FilesIcon size={40} className="text-kumo-inactive" />}
          title={t("requiredNoneTitle")}
          description={t("requiredNoneHint")}
          contents={
            <Button variant="secondary" icon={PlusIcon} onClick={onDeclare}>
              {t("addType")}
            </Button>
          }
          className="py-12"
        />
      </LayerCard>
    );
  }

  return (
    <>
      <FilterBar
        search={{ value: typed, onChange: setTyped, placeholder: t("gapSearchHint") }}
        filters={[
          {
            key: "department",
            label: t("department"),
            value: url.gdept,
            searchable: true,
            onChange: (next) => setUrl({ gdept: next }),
            items: {
              "": t("anyDepartment"),
              ...Object.fromEntries((departments.data ?? []).map((one) => [one.id, `${one.code} · ${one.name}`])),
            },
          },
        ]}
      />
      <DataTable
        id="file-gaps"
        cardLead="person"
        columns={columns}
        rows={rows}
        keyOf={(row) => String(row.employeeId)}
        pending={gaps.isPending}
        failed={gaps.isError}
        onRetry={() => void gaps.refetch()}
        empty={filtering ? t("noGapsInFilter") : t("noGaps")}
        emptyHint={filtering ? undefined : t("noGapsHint")}
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
    </>
  );
}
