"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";

interface Tally {
  employeeId: number;
  fullName: string;
  punches: number;
}

interface Entity {
  id: string;
  name: string;
}

interface Change {
  employeeId: number;
  code: string;
  fullName: string;
  socialInsuranceNo: string | null;
  reason: "HIRED" | "LEFT" | "UNPAID_14" | "SALARY_UP" | "SALARY_DOWN";
  effectiveFrom: string;
  fromSalary: string | null;
  toSalary: string | null;
}

interface Changes {
  unpaidDayThreshold: number;
  increases: Change[];
  decreases: Change[];
  adjustments: Change[];
}

const FILINGS = ["increases", "decreases", "adjustments"] as const;

function firstOfMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function ReportsPage() {
  const t = useTranslations("reports");
  const common = useTranslations("common");
  const year = new Date().getFullYear();
  // A year is a label, not a quantity: as a number it picks up a thousands mark.
  const shown = String(year);
  const from = new Date(Date.UTC(year, 0, 1)).toISOString();
  const to = new Date(Date.UTC(year + 1, 0, 1)).toISOString();
  const [entityId, setEntityId] = useState("");
  const [changeFrom, setChangeFrom] = useState(firstOfMonth);
  const [changeTo, setChangeTo] = useState(today);

  const entities = useQuery({
    queryKey: ["legal-entities"],
    queryFn: async () => (await api.get<Entity[]>("/legal-entities")).data,
  });
  const entity = entityId || entities.data?.[0]?.id || "";

  const changes = useQuery({
    queryKey: ["insurance-changes", entity, changeFrom, changeTo],
    enabled: entity !== "",
    queryFn: async () =>
      (
        await api.get<Changes>(
          `/reports/insurance-changes?legalEntityId=${entity}&from=${changeFrom}&to=${changeTo}`,
        )
      ).data,
  });

  const rollup = useQuery({
    queryKey: ["attendance", from, to],
    queryFn: async () =>
      (await api.get<Tally[]>(`/reports/attendance?from=${from}&to=${to}`)).data,
  });

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">{t("lead", { year: shown })}</p>

      <div className="h-80 rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
        {rollup.isPending ? (
          <p className="text-sm text-(--color-muted)">{common("loading")}</p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rollup.data ?? []}>
              <CartesianGrid stroke="var(--color-line)" vertical={false} />
              <XAxis dataKey="fullName" tick={{ fontSize: 12 }} stroke="var(--color-muted)" />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} stroke="var(--color-muted)" />
              <Tooltip />
              <Bar
                dataKey="punches"
                name={t("punches")}
                fill="var(--color-accent)"
                radius={[6, 6, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      <h2 className="mt-8 text-sm font-medium">{t("insuranceTitle")}</h2>
      <p className="mt-1 text-sm text-(--color-muted)">{t("insuranceLead")}</p>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Select
          aria-label={t("entity")}
          value={entity}
          onChange={(event) => setEntityId(event.target.value)}
          className="w-56"
        >
          {(entities.data ?? []).map((one) => (
            <option key={one.id} value={one.id}>
              {one.name}
            </option>
          ))}
        </Select>
        <Input
          aria-label={t("from")}
          type="date"
          value={changeFrom}
          onChange={(event) => setChangeFrom(event.target.value)}
          className="w-44"
        />
        <Input
          aria-label={t("to")}
          type="date"
          value={changeTo}
          onChange={(event) => setChangeTo(event.target.value)}
          className="w-44"
        />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        {FILINGS.map((filing) => {
          const rows = changes.data?.[filing] ?? [];
          return (
            <article
              key={filing}
              className="rounded-xl border border-(--color-line) bg-(--color-surface) p-4"
            >
              <p className="text-sm font-medium">{t(filing)}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{rows.length}</p>
              {rows.length ? (
                <ul className="mt-3 flex max-h-64 flex-col gap-1 overflow-y-auto text-xs">
                  {rows.slice(0, 50).map((row) => (
                    <li key={`${row.employeeId}-${row.reason}`} className="flex flex-wrap gap-x-2">
                      <span className="font-mono">{row.code}</span>
                      <span className="min-w-0 flex-1 truncate">{row.fullName}</span>
                      <span className="text-(--color-muted)">{t(`reason${row.reason}`)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-xs text-(--color-muted)">{common("noData")}</p>
              )}
              {rows.length > 50 ? (
                <p className="mt-2 text-xs text-(--color-muted)">{t("andMore", { n: rows.length - 50 })}</p>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
