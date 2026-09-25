"use client";

import { Button, Input, SkeletonLine } from "@cloudflare/kumo";
import { FloppyDiskIcon, UserMinusIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { StatePill } from "@/components/ui/pill";
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
  const locale = useLocale();
  const cache = useQueryClient();
  const notify = useNotify();
  const [typed, setTyped] = useState<Record<string, string>>({});

  const sheet = useQuery({
    queryKey: ["payroll-runs", runId, "settlement"],
    queryFn: async () => (await api.get<Sheet>(`/payroll-runs/${runId}/settlement`)).data,
  });

  const rows = sheet.data?.rows ?? [];
  const valueOf = (row: Row, kind: SettlementKind): string => typed[`${row.employeeId}:${kind}`] ?? held(row, kind);
  const dirty = rows.some((row) => KINDS.some((kind) => valueOf(row, kind) !== held(row, kind)));

  const save = useMutation({
    mutationFn: async () => {
      const items = rows.flatMap((row) =>
        KINDS.flatMap((kind) => {
          const amount = Number(valueOf(row, kind));
          return Number.isFinite(amount) && amount > 0 ? [{ employeeId: row.employeeId, kind, amount }] : [];
        }),
      );
      return (await api.post<{ items: number }>(`/payroll-runs/${runId}/settlement`, { items })).data;
    },
    onSuccess: (done) => {
      notify.done(t("settlementSaved", { count: done.items }));
      void cache.invalidateQueries({ queryKey: ["payroll-runs", runId, "settlement"] });
    },
    onError: notify.failed,
  });

  if (sheet.isError) {
    return <Failed onRetry={() => void sheet.refetch()} />;
  }
  if (sheet.isPending) {
    return (
      <div className="flex flex-col gap-3 border-t border-kumo-hairline pt-4">
        <SkeletonLine minWidth={120} maxWidth={260} />
        <SkeletonLine minWidth={120} maxWidth={320} />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-1 border-t border-kumo-hairline pt-4">
        <p className="flex items-center gap-2 font-medium">
          <UserMinusIcon size={16} className="text-kumo-subtle" aria-hidden />
          {t("settlementEmpty")}
        </p>
        <p className="text-kumo-subtle">{t("settlementEmptyHint")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 border-t border-kumo-hairline pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 font-semibold">{t("settlement")}</h3>
        {dirty ? <StatePill tone="waiting">{t("unsaved")}</StatePill> : null}
      </div>
      <p className="text-pretty text-kumo-subtle">{t("settlementLead")}</p>

      {rows.map((row) => (
        <article key={row.employeeId} className="flex flex-col gap-3 border-b border-kumo-hairline pb-4 last:border-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="flex items-baseline gap-2 font-medium">
              {row.fullName}
              <span className="font-mono text-sm font-normal text-kumo-subtle">{row.code}</span>
            </p>
            {row.leaveDate ? (
              <p className="text-sm text-kumo-subtle">
                {t("leaveDate")}: <span className="tabular-nums">{row.leaveDate}</span>
              </p>
            ) : null}
          </div>

          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-3">
            <div className="flex flex-col">
              <dt className="text-sm text-kumo-subtle">{t("tenure")}</dt>
              <dd className="tabular-nums">
                {t("tenureYears", {
                  years: Math.floor(row.tenureMonths / kMonthsPerYear),
                  months: row.tenureMonths % kMonthsPerYear,
                })}
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-sm text-kumo-subtle">{t("halfMonthPay")}</dt>
              <dd className="tabular-nums">{money(Number(row.halfMonthPay), locale)}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-sm text-kumo-subtle">{t("leavePayout")}</dt>
              <dd className="tabular-nums">
                {money(Number(row.leavePayout), locale)}
                <span className="ms-1 text-sm text-kumo-subtle">({days(row.unusedLeaveDays, locale)})</span>
              </dd>
            </div>
          </dl>

          {row.assetsHeld.length > 0 ? (
            <p className="text-kumo-warning">
              {t("stillHolding")}: {row.assetsHeld.map((one) => `${one.code} ${one.name}`).join(" · ")}
            </p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            {KINDS.map((kind) => {
              const key = `${row.employeeId}:${kind}`;
              const value = valueOf(row, kind);
              return (
                <Input
                  key={kind}
                  label={t(kind === "SEVERANCE" ? "severance" : "assetOffset")}
                  inputMode="numeric"
                  disabled={!editable}
                  value={value}
                  description={value !== "" && Number(value) > 0 ? money(Number(value), locale) : undefined}
                  onChange={(event) => setTyped((was) => ({ ...was, [key]: event.target.value }))}
                  className="tabular-nums"
                />
              );
            })}
          </div>
        </article>
      ))}

      {editable ? (
        <Button
          variant="secondary"
          icon={FloppyDiskIcon}
          loading={save.isPending}
          disabled={!dirty}
          onClick={() => save.mutate()}
          className="self-start"
        >
          {t("saveSettlement")}
        </Button>
      ) : null}
    </div>
  );
}
