"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Empty, Failed } from "@/components/ui/empty";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api } from "@/lib/api";

interface Named {
  typeId: string;
  code: string;
  name: string;
}

interface GapPage {
  rows: Gap[];
  total: number;
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

  const rows = gaps.data?.pages.flatMap((one) => one.rows) ?? [];

  if (gaps.isError) {
    return <Failed onRetry={() => gaps.refetch()} />;
  }
  if (gaps.isPending) {
    return <SkeletonRows rows={3} columns={3} />;
  }
  if (rows.length === 0) {
    return <Empty title={t("noGaps")} hint={t("noGapsHint")} />;
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li
          key={row.employeeId}
          className="rounded-xl border border-(--color-line) bg-(--color-surface) p-3"
        >
          <p className="text-sm font-medium">
            {row.fullName} <span className="text-(--color-muted)">· {row.code}</span>
          </p>
          {row.missing.length > 0 ? (
            <p className="mt-1 text-sm">
              <span className="text-(--color-muted)">{t("missing")}: </span>
              {row.missing.map((one) => one.name).join(" · ")}
            </p>
          ) : null}
          {row.expired.length > 0 ? (
            <p className="mt-1 text-sm text-(--color-warn)">
              {t("expired")}:{" "}
              {row.expired.map((one) => `${one.name} (${one.expiresAt})`).join(" · ")}
            </p>
          ) : null}
        </li>
      ))}
      {gaps.hasNextPage ? (
        <li className="flex justify-center">
          <Button
            type="button"
            tone="quiet"
            size="sm"
            disabled={gaps.isFetchingNextPage}
            onClick={() => void gaps.fetchNextPage()}
          >
            {gaps.isFetchingNextPage ? common("loading") : common("loadMore")}
          </Button>
        </li>
      ) : null}
    </ul>
  );
}
