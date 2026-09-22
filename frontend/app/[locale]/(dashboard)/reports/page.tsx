"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Failed } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { dayOnly } from "@/lib/format";

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
  const format = useFormatter();
  const common = useTranslations("common");
  const role = useSession((s) => s.role);
  const faultOf = useFault();
  const mayRollUp = role === "ADMIN" || role === "HR";
  const [entityId, setEntityId] = useState("");
  const [changeFrom, setChangeFrom] = useState(firstOfMonth);
  const [changeTo, setChangeTo] = useState(today);
  const [on, setOn] = useState(today);
  const [fault, setFault] = useState<string | null>(null);

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

  const d02 = useMutation({
    mutationFn: async () => {
      const file = (await api.get<string>(`/reports/d02-lt?legalEntityId=${entity}&on=${on}`)).data;
      const link = document.createElement("a");
      // The api already opens the file with a BOM, so this must not add one.
      link.href = URL.createObjectURL(new Blob([file], { type: "text/csv;charset=utf-8" }));
      link.download = `d02-lt-${on}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const rollUp = useMutation({
    mutationFn: async () =>
      (
        await api.post<{ jobId: string }>("/reports/attendance/monthly", {
          from: changeFrom,
          to: changeTo,
        })
      ).data,
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  if (changes.isError) {
    return <Failed onRetry={() => void changes.refetch()} />;
  }

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">{t("lead")}</p>

      <h2 className="text-sm font-medium">{t("insuranceTitle")}</h2>
      <p className="mt-1 text-sm text-(--color-muted)">{t("insuranceLead")}</p>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="block w-56 text-xs text-(--color-muted)">
          {t("entity")}
          <Select
            value={entity}
            onChange={(event) => setEntityId(event.target.value)}
            className="mt-1"
          >
            {(entities.data ?? []).map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="block w-44 text-xs text-(--color-muted)">
          {t("from")}
          <Input
            type="date"
            value={changeFrom}
            onChange={(event) => setChangeFrom(event.target.value)}
            className="mt-1"
          />
        </label>
        <label className="block w-44 text-xs text-(--color-muted)">
          {t("to")}
          <Input
            type="date"
            value={changeTo}
            onChange={(event) => setChangeTo(event.target.value)}
            className="mt-1"
          />
        </label>
      </div>

      <div className="mt-3 grid items-start gap-3 lg:grid-cols-3">
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

      {mayRollUp ? (
        <>
          <h2 className="mt-10 text-sm font-medium">{t("rollUpTitle")}</h2>
          <p className="mt-1 text-sm text-(--color-muted)">{t("rollUpLead")}</p>
          <p className="mt-1 text-sm">
            <span className="text-(--color-muted)">{t("rollUpRange")}: </span>
            {format.dateTime(dayOnly(changeFrom), "day")} →{" "}
            {format.dateTime(dayOnly(changeTo), "day")}
          </p>
          <Button
            type="button"
            tone="quiet"
            className="mt-3"
            disabled={rollUp.isPending}
            onClick={() => {
              setFault(null);
              rollUp.mutate();
            }}
          >
            {rollUp.isPending ? common("saving") : t("rollUpRun")}
          </Button>
          {rollUp.data ? (
            <p className="mt-2 text-sm text-(--color-ok)">{t("rollUpQueued")}</p>
          ) : null}
        </>
      ) : null}

      <h2 className="mt-10 text-sm font-medium">{t("d02Title")}</h2>
      <p className="mt-1 text-sm text-(--color-muted)">{t("d02Lead")}</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="block w-44 text-xs text-(--color-muted)">
          {t("d02On")}
          <Input
            type="date"
            value={on}
            onChange={(event) => setOn(event.target.value)}
            className="mt-1"
          />
        </label>
        <Button
          type="button"
          disabled={entity === "" || d02.isPending}
          onClick={() => {
            setFault(null);
            d02.mutate();
          }}
        >
          {d02.isPending ? common("loading") : t("d02Download")}
        </Button>
      </div>

      {fault ? (
        <p role="alert" className="mt-4 text-sm text-(--color-danger)">
          {fault}
        </p>
      ) : null}
    </section>
  );
}
