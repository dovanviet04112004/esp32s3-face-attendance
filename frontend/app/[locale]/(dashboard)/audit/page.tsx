"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";

const SUBJECTS = [
  "employee",
  "user",
  "payroll",
  "advance",
  "asset",
  "org",
  "policy",
  "document",
  "device",
  "route",
] as const;

type Subject = (typeof SUBJECTS)[number];

interface Entry {
  id: string;
  actorId: string | null;
  action: string;
  subjectType: Subject;
  subjectId: string;
  ts: string;
  meta: Record<string, unknown> | null;
}

const PAGE = 50;

// The API refuses an offset past this, so the last page it can reach is here.
const MAX_OFFSET = 10_000;

interface EntryPage {
  rows: Entry[];
  total: number;
  totalIsExact?: boolean;
  next?: string | null;
}

export default function AuditPage() {
  const t = useTranslations("audit");
  const common = useTranslations("common");
  const format = useFormatter();

  const [subjectType, setSubjectType] = useState<Subject | "">("");
  const [subjectId, setSubjectId] = useState("");
  const [actorId, setActorId] = useState("");
  const [where, setWhere] = useState("");

  function apply(event: FormEvent): void {
    event.preventDefault();
    setWhere(
      [
        subjectType ? `subjectType=${subjectType}` : "",
        subjectId ? `subjectId=${encodeURIComponent(subjectId)}` : "",
        actorId ? `actorId=${encodeURIComponent(actorId)}` : "",
      ]
        .filter((one) => one !== "")
        .join("&"),
    );
  }

  const entries = useInfiniteQuery({
    queryKey: ["audit", where],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      (await api.get<EntryPage>(`/audit?take=${PAGE}&skip=${pageParam}&${where}`)).data,
    // The log counts by offset, not by cursor, and stops at the same ceiling.
    getNextPageParam: (last, all) => {
      const seen = all.reduce((sum, one) => sum + one.rows.length, 0);
      return last.rows.length === PAGE && seen < Math.min(last.total, MAX_OFFSET)
        ? seen
        : undefined;
    },
  });

  const rows = entries.data?.pages.flatMap((one) => one.rows);
  const counted = entries.data?.pages[0];

  const columns: Column<Entry>[] = [
    {
      id: "at",
      header: t("at"),
      sticky: true,
      sortBy: (row) => row.ts,
      cell: (row) => format.dateTime(new Date(row.ts), "medium"),
    },
    {
      id: "action",
      header: t("action"),
      sortBy: (row) => row.action,
      cell: (row) => <span className="font-mono text-xs">{row.action}</span>,
    },
    {
      id: "subject",
      header: t("subject"),
      sortBy: (row) => row.subjectType,
      cell: (row) => (
        <span>
          {t(`subject${row.subjectType}`)}
          <span className="ms-1 font-mono text-xs text-(--color-muted)">{row.subjectId}</span>
        </span>
      ),
    },
    {
      id: "actor",
      header: t("actor"),
      cell: (row) =>
        row.actorId ? (
          <span className="font-mono text-xs">{row.actorId.slice(0, 8)}</span>
        ) : (
          t("system")
        ),
    },
    {
      id: "meta",
      header: t("meta"),
      cell: (row) =>
        row.meta ? (
          <span className="font-mono text-xs text-(--color-muted)">{JSON.stringify(row.meta)}</span>
        ) : (
          common("empty")
        ),
    },
  ];

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 mb-4 text-sm text-(--color-muted)">{t("lead")}</p>

      <FilterBar onApply={apply}>
        <div className="min-w-44">
          <label className="block text-xs text-(--color-muted)" htmlFor="subjectType">
            {t("subject")}
          </label>
          <Select
            id="subjectType"
            value={subjectType}
            onChange={(event) => setSubjectType(event.target.value as Subject | "")}
          >
            <option value="">{t("anySubject")}</option>
            {SUBJECTS.map((one) => (
              <option key={one} value={one}>
                {t(`subject${one}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-44">
          <label className="block text-xs text-(--color-muted)" htmlFor="subjectId">
            {t("subjectId")}
          </label>
          <Input
            id="subjectId"
            value={subjectId}
            onChange={(event) => setSubjectId(event.target.value)}
          />
        </div>
        <div className="min-w-44 flex-1">
          <label className="block text-xs text-(--color-muted)" htmlFor="actorId">
            {t("actor")}
          </label>
          <Input id="actorId" value={actorId} onChange={(event) => setActorId(event.target.value)} />
        </div>
      </FilterBar>

      <p className="mb-2 text-sm text-(--color-muted)">
        {counted
          ? t(counted.totalIsExact === false ? "foundAtLeast" : "found", {
              count: counted.total,
            })
          : " "}
      </p>

      <DataTable
        id="audit"
        columns={columns}
        rows={rows}
        keyOf={(row) => row.id}
        pending={entries.isPending}
        failed={entries.isError}
        onRetry={() => entries.refetch()}
        empty={t("empty")}
        emptyHint={t("emptyHint")}
        more={
          entries.hasNextPage ? (
            <div className="mt-3 flex flex-col items-center gap-1">
              <Button
                type="button"
                tone="quiet"
                disabled={entries.isFetchingNextPage}
                onClick={() => void entries.fetchNextPage()}
              >
                {entries.isFetchingNextPage ? common("loading") : common("loadMore")}
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
