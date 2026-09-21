"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Empty, Failed } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { days, money } from "@/lib/format";

type SettlementKind = "SEVERANCE" | "ASSET_OFFSET";

interface Typed {
  kind: SettlementKind;
  label: string | null;
  amount: string;
  taxable: boolean;
  note: string | null;
}

interface Row {
  employeeId: number;
  code: string;
  fullName: string;
  leaveDate: string | null;
  tenureMonths: number;
  baseSalary: string;
  halfMonthPay: string;
  unusedLeaveDays: number;
  leavePayout: string;
  assetsHeld: { code: string; name: string }[];
  typed: Typed[];
}

interface Sheet {
  runId: string;
  periodId: string;
  rows: Row[];
}

const KINDS: SettlementKind[] = ["SEVERANCE", "ASSET_OFFSET"];
const kMonthsPerYear = 12;

function held(row: Row, kind: SettlementKind): string {
  const found = row.typed.find((one) => one.kind === kind);
  return found ? found.amount : "";
}

/** Everything the system derives, beside boxes for the two it cannot. */
export function SettlementSheet({ runId, editable }: { runId: string; editable: boolean }) {
  const t = useTranslations("payroll");
  const common = useTranslations("common");
  const locale = useLocale();
  const cache = useQueryClient();
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState(false);

  const sheet = useQuery({
    queryKey: ["payroll-runs", runId, "settlement"],
    queryFn: async () => (await api.get<Sheet>(`/payroll-runs/${runId}/settlement`)).data,
  });

  const save = useMutation({
    mutationFn: async () => {
      const rows = sheet.data?.rows ?? [];
      const items = rows.flatMap((row) =>
        KINDS.map((kind) => {
          const key = `${row.employeeId}:${kind}`;
          const amount = Number(typed[key] ?? held(row, kind));
          return Number.isFinite(amount) && amount > 0
            ? [{ employeeId: row.employeeId, kind, amount }]
            : [];
        }).flat(),
      );
      return api.post(`/payroll-runs/${runId}/settlement`, { items });
    },
    onSuccess: () => {
      setRefused(false);
      void cache.invalidateQueries({ queryKey: ["payroll-runs", runId, "settlement"] });
    },
    onError: () => setRefused(true),
  });

  if (sheet.isError) {
    return <Failed onRetry={() => sheet.refetch()} />;
  }
  if (sheet.isPending) {
    return <SkeletonRows rows={2} columns={4} />;
  }
  if (sheet.data.rows.length === 0) {
    return <Empty title={t("settlementEmpty")} hint={t("settlementEmptyHint")} />;
  }

  return (
    <div className="flex flex-col gap-3">
      {sheet.data.rows.map((row) => (
        <article
          key={row.employeeId}
          className="rounded-xl border border-(--color-line) bg-(--color-surface) p-4"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium">
              {row.fullName} <span className="text-(--color-muted)">· {row.code}</span>
            </p>
            {row.leaveDate ? (
              <p className="text-xs text-(--color-muted)">
                {t("leaveDate")}: <span className="tabular-nums">{row.leaveDate}</span>
              </p>
            ) : null}
          </div>

          <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-(--color-muted)">{t("tenure")}</dt>
              <dd className="tabular-nums">
                {t("tenureYears", {
                  years: Math.floor(row.tenureMonths / kMonthsPerYear),
                  months: row.tenureMonths % kMonthsPerYear,
                })}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-(--color-muted)">{t("halfMonthPay")}</dt>
              <dd className="tabular-nums">{money(Number(row.halfMonthPay), locale)}</dd>
            </div>
            <div>
              <dt className="text-xs text-(--color-muted)">{t("leavePayout")}</dt>
              <dd className="tabular-nums">
                {money(Number(row.leavePayout), locale)}
                <span className="ms-1 text-xs text-(--color-muted)">
                  ({days(row.unusedLeaveDays, locale)})
                </span>
              </dd>
            </div>
          </dl>

          {row.assetsHeld.length > 0 ? (
            <p className="mt-3 text-sm text-(--color-warn)">
              {t("stillHolding")}:{" "}
              {row.assetsHeld.map((one) => `${one.code} ${one.name}`).join(" · ")}
            </p>
          ) : null}

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {KINDS.map((kind) => {
              const key = `${row.employeeId}:${kind}`;
              return (
                <div key={kind}>
                  <label className="block text-xs text-(--color-muted)" htmlFor={key}>
                    {t(kind === "SEVERANCE" ? "severance" : "assetOffset")}
                  </label>
                  <Input
                    id={key}
                    inputMode="numeric"
                    disabled={!editable}
                    value={typed[key] ?? held(row, kind)}
                    onChange={(event) =>
                      setTyped((was) => ({ ...was, [key]: event.target.value }))
                    }
                    className="mt-1 tabular-nums"
                  />
                </div>
              );
            })}
          </div>
        </article>
      ))}

      {refused ? (
        <p role="alert" className="text-sm text-(--color-danger)">
          {common("failed")}
        </p>
      ) : null}

      {editable ? (
        <Button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? common("saving") : t("saveSettlement")}
        </Button>
      ) : null}
    </div>
  );
}
