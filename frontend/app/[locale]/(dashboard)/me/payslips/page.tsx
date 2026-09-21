"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { DisputeCard, type Dispute } from "@/components/payroll/dispute-card";
import { PayslipView, useLineName, type Payslip } from "@/components/payroll/payslip-view";
import { Button } from "@/components/ui/button";
import { Empty, Failed } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { useFault } from "@/lib/fault";
import { money } from "@/lib/format";

interface PayslipRow {
  id: string;
  periodId: string;
  state: Payslip["state"];
  netPay: string;
  period?: { year: number; month: number };
}

const THIS_YEAR = new Date().getUTCFullYear();
const YEARS = [THIS_YEAR, THIS_YEAR - 1, THIS_YEAR - 2];

interface TaxYear {
  year: number;
  months: { month: number }[];
  grossTotal: string;
  insuranceTotal: string;
  reliefSelfTotal: string;
  reliefDependentTotal: string;
  exemptOvertimeTotal: string;
  assessableTotal: string;
  taxDue: string;
  taxWithheld: string;
  difference: string;
}

interface Delta {
  code: string;
  thisPeriod: string;
  lastPeriod: string;
  difference: string;
}

export default function MyPayslipsPage() {
  const t = useTranslations("payroll");
  const d = useTranslations("disputes");
  const locale = useLocale();
  const [openId, setOpenId] = useState<string | null>(null);
  const [claim, setClaim] = useState("");
  const [lineCode, setLineCode] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const [year, setYear] = useState(THIS_YEAR);
  const employeeId = useSession((one) => one.employeeId);

  const statement = useQuery({
    queryKey: ["tax-year", employeeId, year],
    enabled: employeeId !== null,
    queryFn: async () => (await api.get<TaxYear>(`/tax-year/${employeeId}?year=${year}`)).data,
  });
  const nameOf = useLineName();
  const cache = useQueryClient();
  const faultOf = useFault();

  const mine = useQuery({
    queryKey: ["payslips", "mine", employeeId],
    enabled: employeeId !== null,
    queryFn: async () =>
      (await api.get<PayslipRow[]>(`/payslips?employeeId=${employeeId}`)).data,
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

  const disputes = useQuery({
    queryKey: ["payslip-disputes", "mine", employeeId],
    enabled: employeeId !== null,
    queryFn: async () =>
      (await api.get<{ rows: Dispute[] }>(`/payslip-disputes?employeeId=${employeeId}`)).data.rows,
  });

  const raise = useMutation({
    mutationFn: async () =>
      api.post("/payslip-disputes", {
        payslipId: chosen,
        claim,
        ...(lineCode === "" ? {} : { lineCode }),
      }),
    onSuccess: () => {
      setClaim("");
      setRefused(null);
      void cache.invalidateQueries({ queryKey: ["payslip-disputes"] });
    },
    onError: (fell) => setRefused(faultOf(fell)),
  });

  const withdraw = useMutation({
    mutationFn: async (id: string) => api.post(`/payslip-disputes/${id}/withdraw`, {}),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["payslip-disputes"] }),
    onError: (fell) => setRefused(faultOf(fell)),
  });

  if (mine.isError) {
    return <Failed onRetry={() => mine.refetch()} />;
  }

  const onThisSlip = (disputes.data ?? []).filter((one) => one.payslipId === chosen);

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
          <ul
            aria-label={t("myTitle")}
            className="max-h-56 overflow-y-auto rounded-xl border border-(--color-line) bg-(--color-surface) sm:max-h-72"
          >
            {mine.data.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  aria-current={row.id === chosen ? "true" : undefined}
                  onClick={() => setOpenId(row.id)}
                  className={cn(
                    "flex min-h-11 w-full items-center justify-between gap-3 border-b border-(--color-line) px-4 text-sm last:border-0",
                    row.id === chosen
                      ? "bg-(--color-ground) font-medium"
                      : "hover:bg-(--color-ground)",
                  )}
                >
                  <span className="tabular-nums">
                    {row.period
                      ? `${String(row.period.month).padStart(2, "0")}/${row.period.year}`
                      : t("period")}
                  </span>
                  <span className="tabular-nums">{money(Number(row.netPay), locale)}</span>
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-4" data-print>
            {slip.isPending ? (
              <SkeletonRows rows={6} columns={2} />
            ) : slip.data ? (
              <PayslipView slip={slip.data} />
            ) : null}
          </div>

          {slip.data ? (
            <Button
              type="button"
              tone="quiet"
              size="sm"
              className="mt-3"
              onClick={() => window.print()}
            >
              {t("printSlip")}
            </Button>
          ) : null}

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

          {chosen && slip.data && slip.data.state !== "DRAFT" ? (
            <section className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
              <h2 className="text-sm font-medium">{d("title")}</h2>
              <p className="mt-1 text-sm text-(--color-muted)">{d("lead")}</p>

              <form
                className="mt-3 flex flex-col gap-2"
                onSubmit={(event: FormEvent) => {
                  event.preventDefault();
                  raise.mutate();
                }}
              >
                <label className="text-sm font-medium" htmlFor="lineCode">
                  {d("line")}
                </label>
                <Select
                  id="lineCode"
                  value={lineCode}
                  onChange={(event) => setLineCode(event.target.value)}
                >
                  <option value="">{d("lineAny")}</option>
                  {slip.data.lines.map((one) => (
                    <option key={one.id} value={one.code}>
                      {nameOf(one.code, one.label)}
                    </option>
                  ))}
                </Select>
                <label className="text-sm font-medium" htmlFor="claim">
                  {d("claim")}
                </label>
                <Input
                  id="claim"
                  required
                  value={claim}
                  placeholder={d("claimHint")}
                  onChange={(event) => setClaim(event.target.value)}
                />
                {refused ? (
                  <p role="alert" className="text-sm text-(--color-danger)">
                    {refused}
                  </p>
                ) : null}
                <Button type="submit" size="sm" disabled={raise.isPending} className="self-start">
                  {raise.isPending ? d("raising") : d("raise")}
                </Button>
              </form>

              {onThisSlip.length === 0 ? (
                <p className="mt-3 text-sm text-(--color-muted)">{d("empty")}</p>
              ) : (
                <ul className="mt-3 flex flex-col gap-2">
                  {onThisSlip.map((one) => (
                    <DisputeCard
                      key={one.id}
                      dispute={one}
                      busy={withdraw.isPending}
                      onWithdraw={(id) => withdraw.mutate(id)}
                    />
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          <section className="mt-10">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 className="text-sm font-medium">{t("taxYearTitle")}</h2>
                <p className="mt-1 text-sm text-(--color-muted)">{t("taxYearLead")}</p>
              </div>
              <Select
                aria-label={t("taxYear")}
                value={String(year)}
                onChange={(event) => setYear(Number(event.target.value))}
                className="w-32"
              >
                {YEARS.map((one) => (
                  <option key={one} value={one}>
                    {one}
                  </option>
                ))}
              </Select>
            </div>

            {statement.isPending ? (
              <SkeletonRows rows={3} columns={2} />
            ) : !statement.data || statement.data.months.length === 0 ? (
              <p className="mt-3 text-sm text-(--color-muted)">{t("taxYearEmpty")}</p>
            ) : (
              <dl className="mt-3 rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
                {(
                  [
                    ["taxGross", statement.data.grossTotal],
                    ["taxInsurance", statement.data.insuranceTotal],
                    ["taxReliefSelf", statement.data.reliefSelfTotal],
                    ["taxReliefDependent", statement.data.reliefDependentTotal],
                    ["taxExemptOvertime", statement.data.exemptOvertimeTotal],
                    ["taxAssessable", statement.data.assessableTotal],
                    ["taxDue", statement.data.taxDue],
                    ["taxWithheld", statement.data.taxWithheld],
                    ["taxDifference", statement.data.difference],
                  ] as const
                ).map(([key, value]) => (
                  <div
                    key={key}
                    className="flex justify-between gap-3 border-b border-(--color-line) py-2 text-sm last:border-0"
                  >
                    <dt className="text-(--color-muted)">{t(key)}</dt>
                    <dd className="tabular-nums">{money(Number(value), locale)}</dd>
                  </div>
                ))}
                <p className="mt-3 text-xs text-(--color-muted)">
                  {t("taxYearMonths", { count: statement.data.months.length })}
                </p>
              </dl>
            )}
          </section>
        </>
      )}
    </section>
  );
}
