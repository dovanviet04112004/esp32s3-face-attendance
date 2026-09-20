"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { PayslipView, useLineName, type Payslip } from "@/components/payroll/payslip-view";
import { Button } from "@/components/ui/button";
import { Empty, Failed } from "@/components/ui/empty";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { money } from "@/lib/format";

interface PayslipRow {
  id: string;
  periodId: string;
  state: Payslip["state"];
  netPay: string;
  period?: { year: number; month: number };
}

interface Delta {
  code: string;
  thisPeriod: string;
  lastPeriod: string;
  difference: string;
}

export default function MyPayslipsPage() {
  const t = useTranslations("payroll");
  const locale = useLocale();
  const [openId, setOpenId] = useState<string | null>(null);
  const nameOf = useLineName();

  const mine = useQuery({
    queryKey: ["payslips", "mine"],
    queryFn: async () => (await api.get<PayslipRow[]>("/payslips")).data,
  });

  const chosen = openId ?? mine.data?.[0]?.id ?? null;

  const slip = useQuery({
    queryKey: ["payslips", chosen],
    enabled: chosen !== null,
    queryFn: async () => (await api.get<Payslip>(`/payslips/${chosen}`)).data,
  });

  const delta = useQuery({
    queryKey: ["payslips", chosen, "compare"],
    enabled: chosen !== null,
    queryFn: async () => (await api.get<Delta[]>(`/payslips/${chosen}/compare`)).data,
  });

  if (mine.isError) {
    return <Failed onRetry={() => mine.refetch()} />;
  }

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("myTitle")}</h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">{t("lead")}</p>

      {mine.isPending ? (
        <SkeletonRows rows={3} columns={3} />
      ) : !mine.data?.length ? (
        <Empty title={t("empty")} />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {mine.data.map((row) => (
              <Button
                key={row.id}
                type="button"
                tone={row.id === chosen ? "solid" : "quiet"}
                size="sm"
                onClick={() => setOpenId(row.id)}
              >
                {row.period ? `${row.period.month}/${row.period.year}` : t("period")}
                <span className="tabular-nums">{money(Number(row.netPay), locale)}</span>
              </Button>
            ))}
          </div>

          <div className="mt-4">
            {slip.isPending ? (
              <SkeletonRows rows={6} columns={2} />
            ) : slip.data ? (
              <PayslipView slip={slip.data} />
            ) : null}
          </div>

          {delta.data && delta.data.length > 0 ? (
            <section className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
              <h2 className="text-sm font-medium">{t("compare")}</h2>
              <dl className="mt-2 flex flex-col">
                {delta.data.map((row) => (
                  <div
                    key={row.code}
                    className="flex justify-between gap-3 border-b border-(--color-line) py-2 text-sm last:border-0"
                  >
                    <dt>{nameOf(row.code)}</dt>
                    <dd
                      className={cn(
                        "tabular-nums",
                        Number(row.difference) < 0 ? "text-(--color-danger)" : "text-(--color-ok)",
                      )}
                    >
                      {Number(row.difference) > 0 ? "+" : ""}
                      {money(Number(row.difference), locale)}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
        </>
      )}
    </section>
  );
}
