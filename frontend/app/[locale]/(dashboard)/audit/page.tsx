"use client";

import { LayerDialog, LinkButton } from "@cloudflare/kumo";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { AsideCard, Facts, PageHeader, PageLayout, StatList } from "@/components/ui/page";
import { api } from "@/lib/api";

const SUBJECTS = [
  "employee",
  "user",
  "payroll",
  "advance",
  "asset",
  "org",
  "policy",
  "leaveType",
  "document",
  "device",
  "release",
  "route",
] as const;

type Subject = (typeof SUBJECTS)[number];

interface Entry {
  id: string;
  actorId: string | null;
  actor: { email: string } | null;
  action: string;
  subjectType: Subject;
  subjectId: string;
  ts: string;
  meta: Record<string, unknown> | null;
}

interface EntryPage {
  rows: Entry[];
  total: number;
  totalIsExact?: boolean;
  next?: string | null;
}

interface Account {
  id: string;
  email: string;
}

// A subject with a page of its own; the rest are read here only.
const SUBJECT_PAGE: Partial<Record<Subject, (id: string) => string>> = {
  employee: (id) => `/employees/${id}`,
  device: (id) => `/devices/${id}`,
};

const PAGE = 50;
const kAccountTake = 200;

// The API refuses an offset past this, so the last page it can reach is here.
const MAX_OFFSET = 10_000;

function subjectOf(raw: string): Subject | "" {
  return (SUBJECTS as readonly string[]).includes(raw) ? (raw as Subject) : "";
}

export default function AuditPage() {
  const t = useTranslations("audit");
  const common = useTranslations("common");
  const format = useFormatter();

  const [subjectType, setSubjectType] = useState<Subject | "">("");
  const [typed, setTyped] = useState("");
  const subjectId = useSettled(typed.trim());
  const [actorId, setActorId] = useState("");
  const [open, setOpen] = useState<Entry | null>(null);

  const accounts = useQuery({
    queryKey: ["users", "for-audit"],
    queryFn: async () => (await api.get<{ rows: Account[] }>(`/users?take=${kAccountTake}`)).data.rows,
  });

  const where = new URLSearchParams(
    Object.entries({ subjectType, subjectId, actorId }).filter(([, value]) => value !== ""),
  ).toString();

  const entries = useInfiniteQuery({
    queryKey: ["audit", where],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      (await api.get<EntryPage>(`/audit?take=${PAGE}&skip=${pageParam}${where ? `&${where}` : ""}`)).data,
    // The log counts by offset, not by cursor, and stops at the same ceiling.
    getNextPageParam: (last, all) => {
      const seen = all.reduce((sum, one) => sum + one.rows.length, 0);
      return last.rows.length === PAGE && seen < Math.min(last.total, MAX_OFFSET) ? seen : undefined;
    },
  });

  const rows = entries.data?.pages.flatMap((one) => one.rows);
  const counted = entries.data?.pages[0];
  const filtered = where !== "";
  const subjectName = (one: Subject) => t(`subject${one}`);

  const columns: Column<Entry>[] = [
    {
      id: "at",
      header: t("at"),
      sticky: true,
      sortBy: (row) => row.ts,
      cell: (row) => <span className="whitespace-nowrap tabular-nums">{format.dateTime(new Date(row.ts), "medium")}</span>,
    },
    {
      id: "action",
      header: t("action"),
      sortBy: (row) => row.action,
      cell: (row) => <span className="font-mono text-sm">{row.action}</span>,
    },
    {
      id: "subject",
      header: t("subject"),
      sortBy: (row) => row.subjectType,
      cell: (row) => (
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span>{subjectName(row.subjectType)}</span>
          <span className="font-mono text-sm break-all text-kumo-subtle">{row.subjectId}</span>
        </span>
      ),
    },
    {
      id: "actor",
      header: t("actor"),
      sortBy: (row) => row.actor?.email ?? "",
      cell: (row) =>
        row.actor ? <span className="break-all">{row.actor.email}</span> : <span className="text-kumo-subtle">{t("system")}</span>,
    },
  ];

  const pageOf = open ? SUBJECT_PAGE[open.subjectType] : undefined;

  return (
    <>
      <PageHeader title={t("title")} description={t("lead")} />

      <PageLayout
        aside={
          <AsideCard title={t("bySubject")}>
            <StatList
              stats={[
                { key: "all", label: t("anySubject"), value: "", active: subjectType === "", onPick: () => setSubjectType("") },
                ...SUBJECTS.map((one) => ({
                  key: one,
                  label: subjectName(one),
                  value: "",
                  active: subjectType === one,
                  onPick: () => setSubjectType(one),
                })),
              ]}
            />
          </AsideCard>
        }
      >
        <FilterBar
          search={{ value: typed, onChange: setTyped, placeholder: t("subjectIdHint") }}
          filters={[
            {
              key: "subject",
              label: t("subject"),
              value: subjectType,
              onChange: (next) => setSubjectType(subjectOf(next)),
              items: { "": t("anySubject"), ...Object.fromEntries(SUBJECTS.map((one) => [one, subjectName(one)])) },
            },
            {
              key: "actor",
              label: t("actor"),
              value: actorId,
              onChange: setActorId,
              items: {
                "": t("anyActor"),
                ...Object.fromEntries((accounts.data ?? []).map((one) => [one.id, one.email])),
              },
            },
          ]}
        />
        <DataTable
          id="audit"
          cardLead="action"
          columns={columns}
          rows={rows}
          keyOf={(row) => row.id}
          pending={entries.isPending}
          failed={entries.isError}
          onRetry={() => void entries.refetch()}
          onRowClick={setOpen}
          empty={filtered ? t("empty") : t("emptyAll")}
          emptyHint={filtered ? t("emptyHint") : undefined}
          paging={
            counted
              ? {
                  shown: rows?.length ?? 0,
                  total: counted.total,
                  exact: counted.totalIsExact,
                  onMore: entries.hasNextPage ? () => void entries.fetchNextPage() : undefined,
                  loading: entries.isFetchingNextPage,
                }
              : undefined
          }
        />
      </PageLayout>

      <LayerDialog.Root open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <LayerDialog.Content size="lg" closeLabel={common("close")}>
          <LayerDialog.Title>{open ? open.action : t("title")}</LayerDialog.Title>
          <LayerDialog.Body>
            {open ? (
              <div className="flex flex-col gap-4">
                <Facts
                  rows={[
                    [t("at"), format.dateTime(new Date(open.ts), "medium")],
                    [t("subject"), `${subjectName(open.subjectType)} · ${open.subjectId}`],
                    [t("actor"), open.actor?.email ?? t("system")],
                  ]}
                />
                <div className="flex flex-col gap-1.5">
                  <span className="font-medium">{t("meta")}</span>
                  {open.meta ? (
                    <pre className="m-0 overflow-x-auto rounded-lg bg-kumo-tint p-3 font-mono text-sm whitespace-pre-wrap break-all">
                      {JSON.stringify(open.meta, null, 2)}
                    </pre>
                  ) : (
                    <span className="text-kumo-subtle">{common("empty")}</span>
                  )}
                </div>
                {pageOf ? (
                  <LinkButton href={pageOf(open.subjectId)} variant="secondary" icon={ArrowSquareOutIcon} className="self-start">
                    {t("openSubject")}
                  </LinkButton>
                ) : null}
              </div>
            ) : null}
          </LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}
