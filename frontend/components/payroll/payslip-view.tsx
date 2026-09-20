"use client";

import { useLocale, useTranslations } from "next-intl";

import { cn } from "@/lib/cn";
import { days, hours, money } from "@/lib/format";

export type LineKind = "EARNING" | "DEDUCTION" | "EMPLOYER_COST" | "INFO";

export interface PayslipLine {
  id: string;
  ordinal: number;
  kind: LineKind;
  code: string;
  label: string | null;
  amount: string;
  quantity: string | null;
  rateBp: number | null;
}

export interface Payslip {
  id: string;
  state: "DRAFT" | "ISSUED" | "SENT" | "VIEWED";
  workedDays: string;
  paidLeaveDays: string;
  unpaidDays: string;
  workedMinutes: number;
  overtimeMinutes: number;
  grossPay: string;
  taxableIncome: string;
  insuranceEmployee: string;
  personalIncomeTax: string;
  deductionsTotal: string;
  netPay: string;
  lines: PayslipLine[];
}

const ORDER: LineKind[] = ["EARNING", "DEDUCTION", "EMPLOYER_COST", "INFO"];

const GROUP: Record<LineKind, "earnings" | "deductions" | "employerCost" | "info"> = {
  EARNING: "earnings",
  DEDUCTION: "deductions",
  EMPLOYER_COST: "employerCost",
  INFO: "info",
};

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
      <p className="text-xs text-(--color-muted)">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/** A component the catalogue does not name is one whose text came from data. */
export function useLineName(): (code: string, label?: string | null) => string {
  const t = useTranslations("payroll");
  return (code, label) => {
    const key = `LINE_${code}` as "LINE_BASE";
    return t.has(key) ? t(key) : (label ?? code);
  };
}

export function PayslipView({ slip }: { slip: Payslip }) {
  const t = useTranslations("payroll");
  const locale = useLocale();
  const nameOf = useLineName();

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label={t("gross")} value={money(Number(slip.grossPay), locale)} />
        <Figure label={t("insurance")} value={money(Number(slip.insuranceEmployee), locale)} />
        <Figure label={t("tax")} value={money(Number(slip.personalIncomeTax), locale)} />
        <Figure label={t("net")} value={money(Number(slip.netPay), locale)} />
      </div>

      <dl className="mt-4 grid gap-x-6 gap-y-2 rounded-xl border border-(--color-line) bg-(--color-surface) p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex justify-between gap-3">
          <dt className="text-(--color-muted)">{t("workedDays")}</dt>
          <dd className="tabular-nums">{days(Number(slip.workedDays), locale)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-(--color-muted)">{t("paidLeaveDays")}</dt>
          <dd className="tabular-nums">{days(Number(slip.paidLeaveDays), locale)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-(--color-muted)">{t("unpaidDays")}</dt>
          <dd className="tabular-nums">{days(Number(slip.unpaidDays), locale)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-(--color-muted)">{t("overtime")}</dt>
          <dd className="tabular-nums">{hours(slip.overtimeMinutes, locale)}</dd>
        </div>
      </dl>

      {ORDER.map((kind) => {
        const rows = slip.lines.filter((line) => line.kind === kind);
        if (rows.length === 0) {
          return null;
        }
        const total = rows.reduce((sum, line) => sum + Number(line.amount), 0);
        return (
          <section
            key={kind}
            className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface) p-4"
          >
            <h2 className="text-sm font-medium">{t(GROUP[kind])}</h2>
            <dl className="mt-2 flex flex-col">
              {rows.map((line) => (
                <div
                  key={line.id}
                  className="flex justify-between gap-3 border-b border-(--color-line) py-2 text-sm last:border-0"
                >
                  <dt className="min-w-0">{nameOf(line.code, line.label)}</dt>
                  <dd
                    className={cn(
                      "shrink-0 tabular-nums",
                      kind === "DEDUCTION" && "text-(--color-danger)",
                      kind === "INFO" && "text-(--color-muted)",
                    )}
                  >
                    {kind === "DEDUCTION" ? "− " : ""}
                    {money(Number(line.amount), locale)}
                  </dd>
                </div>
              ))}
            </dl>
            {kind !== "INFO" ? (
              <p className="mt-2 text-end text-sm font-medium tabular-nums">
                {money(total, locale)}
              </p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
