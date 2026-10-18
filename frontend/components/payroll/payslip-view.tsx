"use client";

import { LayerCard } from "@cloudflare/kumo";
import { useLocale, useTranslations } from "next-intl";

import { Facts } from "@/components/ui/page";
import { cn } from "@/lib/cn";
import { days, hours, money } from "@/lib/format";

type LineKind = "EARNING" | "DEDUCTION" | "EMPLOYER_COST" | "INFO";

interface PayslipLine {
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

type Section = LineKind | "CARRIED";

const ORDER: Section[] = ["EARNING", "DEDUCTION", "CARRIED", "EMPLOYER_COST", "INFO"];

const GROUP: Record<Section, "earnings" | "deductions" | "carried" | "employerCost" | "info"> = {
  EARNING: "earnings",
  DEDUCTION: "deductions",
  CARRIED: "carried",
  EMPLOYER_COST: "employerCost",
  INFO: "info",
};

const LINE_CARRY_OUT = "CARRY_OUT";

// A shortfall reads beside the deductions it outgrew, not among the tax workings (KEHOACH 9.6).
function sectionOf(line: PayslipLine): Section {
  return line.code === LINE_CARRY_OUT ? "CARRIED" : line.kind;
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <LayerCard className="flex min-w-0 flex-col gap-1 p-4">
      <span className="text-sm text-kumo-subtle">{label}</span>
      <span className="text-lg font-semibold break-words tabular-nums">{value}</span>
    </LayerCard>
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
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label={t("net")} value={money(Number(slip.netPay), locale)} />
        <Figure label={t("gross")} value={money(Number(slip.grossPay), locale)} />
        <Figure label={t("insurance")} value={money(Number(slip.insuranceEmployee), locale)} />
        <Figure label={t("tax")} value={money(Number(slip.personalIncomeTax), locale)} />
      </div>

      <LayerCard className="p-4">
        <div className="grid gap-x-8 sm:grid-cols-2">
          <Facts
            rows={[
              [t("workedDays"), <span key="w" className="tabular-nums">{days(Number(slip.workedDays), locale)}</span>],
              [t("paidLeaveDays"), <span key="p" className="tabular-nums">{days(Number(slip.paidLeaveDays), locale)}</span>],
            ]}
          />
          <Facts
            rows={[
              [t("unpaidDays"), <span key="u" className="tabular-nums">{days(Number(slip.unpaidDays), locale)}</span>],
              [t("overtime"), <span key="o" className="tabular-nums">{hours(slip.overtimeMinutes, locale)}</span>],
            ]}
          />
        </div>
      </LayerCard>

      {ORDER.map((section) => {
        const rows = slip.lines.filter((line) => sectionOf(line) === section);
        if (rows.length === 0) {
          return null;
        }
        const total = rows.reduce((sum, line) => sum + Number(line.amount), 0);
        return (
          <LayerCard key={section}>
            <LayerCard.Secondary className="justify-between">
              <span>{t(GROUP[section])}</span>
              {section !== "INFO" ? (
                <span className="font-medium text-kumo-default tabular-nums">{money(total, locale)}</span>
              ) : null}
            </LayerCard.Secondary>
            <LayerCard.Primary>
              <dl className="-my-1 flex flex-col">
                {rows.map((line) => (
                  <div
                    key={line.id}
                    className="flex items-baseline justify-between gap-3 border-b border-kumo-hairline py-2 last:border-0"
                  >
                    <dt className="min-w-0">{nameOf(line.code, line.label)}</dt>
                    <dd
                      className={cn(
                        "shrink-0 tabular-nums",
                        section === "DEDUCTION" && "text-kumo-danger",
                        section === "INFO" && "text-kumo-subtle",
                      )}
                    >
                      {section === "DEDUCTION" ? "− " : ""}
                      {money(Number(line.amount), locale)}
                    </dd>
                  </div>
                ))}
              </dl>
            </LayerCard.Primary>
          </LayerCard>
        );
      })}
    </div>
  );
}
