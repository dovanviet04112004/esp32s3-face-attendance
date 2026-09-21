"use client";

import { useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
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

  const rows = useQuery({
    queryKey: ["audit", where],
    queryFn: async () =>
      (await api.get<{ rows: Entry[]; total: number }>(`/audit?take=${PAGE}&${where}`)).data,
  });

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
        {rows.data ? t("found", { count: rows.data.total }) : " "}
      </p>

      <DataTable
        id="audit"
        columns={columns}
        rows={rows.data?.rows}
        keyOf={(row) => row.id}
        pending={rows.isPending}
        failed={rows.isError}
        onRetry={() => rows.refetch()}
        empty={t("empty")}
        emptyHint={t("emptyHint")}
      />
    </section>
  );
}
