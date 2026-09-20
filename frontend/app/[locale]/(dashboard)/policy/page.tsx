"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";

import { Empty, Failed } from "@/components/ui/empty";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { money, percent } from "@/lib/format";

interface Bracket {
  id: string;
  ordinal: number;
  upToAmount: string | null;
  rateBp: number;
}

interface Policy {
  id: string;
  effectiveFrom: string;
  selfDeduction: string;
  dependentDeduction: string;
  socialRateBp: number;
  healthRateBp: number;
  unemploymentRateBp: number;
  employerSocialRateBp: number;
  employerHealthRateBp: number;
  employerUnemploymentRateBp: number;
  referenceWage: string;
  socialCapMultiple: number;
  regionalMinimumWage: string;
  unemploymentCapMultiple: number;
  standardDaysPerMonth: string;
  noContributionUnpaidDays: number;
  overtimeWeekdayBp: number;
  overtimeWeekendBp: number;
  overtimeHolidayBp: number;
  nightPremiumBp: number;
  note: string | null;
  brackets: Bracket[];
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-(--color-line) py-2 text-sm last:border-0">
      <dt className="text-(--color-muted)">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

export default function PolicyPage() {
  const t = useTranslations("policy");
  const locale = useLocale();

  const policies = useQuery({
    queryKey: ["payroll-policies"],
    queryFn: async () => (await api.get<Policy[]>("/payroll-policies")).data,
  });

  if (policies.isError) {
    return <Failed onRetry={() => policies.refetch()} />;
  }

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">{t("lead")}</p>

      {policies.isPending ? (
        <SkeletonRows rows={4} columns={2} />
      ) : !policies.data?.length ? (
        <Empty title={t("empty")} />
      ) : (
        policies.data.map((policy) => (
          <article
            key={policy.id}
            className="mb-4 rounded-xl border border-(--color-line) bg-(--color-surface) p-4"
          >
            <h2 className="text-sm font-semibold">
              {t("effectiveFrom")} {policy.effectiveFrom.slice(0, 10)}
            </h2>
            {policy.note ? (
              <p className="mt-1 text-sm text-(--color-muted)">{policy.note}</p>
            ) : null}

            <div className="mt-3 grid gap-x-8 sm:grid-cols-2">
              <dl>
                <Row
                  label={t("selfDeduction")}
                  value={money(Number(policy.selfDeduction), locale)}
                />
                <Row
                  label={t("dependentDeduction")}
                  value={money(Number(policy.dependentDeduction), locale)}
                />
                <Row label={t("standardDays")} value={policy.standardDaysPerMonth} />
                <Row
                  label={t("rates")}
                  value={[policy.socialRateBp, policy.healthRateBp, policy.unemploymentRateBp]
                    .map((bp) => percent(bp / 10_000, locale))
                    .join(" · ")}
                />
                <Row
                  label={t("employerRates")}
                  value={[
                    policy.employerSocialRateBp,
                    policy.employerHealthRateBp,
                    policy.employerUnemploymentRateBp,
                  ]
                    .map((bp) => percent(bp / 10_000, locale))
                    .join(" · ")}
                />
              </dl>
              <dl>
                <Row
                  label={t("referenceWage")}
                  value={money(Number(policy.referenceWage), locale)}
                />
                <Row
                  label={t("socialCap")}
                  value={money(
                    Number(policy.referenceWage) * policy.socialCapMultiple,
                    locale,
                  )}
                />
                <Row
                  label={t("regionalMinimumWage")}
                  value={money(Number(policy.regionalMinimumWage), locale)}
                />
                <Row
                  label={t("unemploymentCap")}
                  value={money(
                    Number(policy.regionalMinimumWage) * policy.unemploymentCapMultiple,
                    locale,
                  )}
                />
                <Row
                  label={t("overtimeRates")}
                  value={[
                    policy.overtimeWeekdayBp,
                    policy.overtimeWeekendBp,
                    policy.overtimeHolidayBp,
                    policy.nightPremiumBp,
                  ]
                    .map((bp) => percent(bp / 10_000, locale))
                    .join(" · ")}
                />
              </dl>
            </div>

            <h3 className="mt-4 text-sm font-medium">{t("brackets")}</h3>
            <dl className="mt-1">
              {policy.brackets.map((bracket) => (
                <Row
                  key={bracket.id}
                  label={
                    bracket.upToAmount === null
                      ? `${t("over")} ${money(Number(policy.brackets.at(-2)?.upToAmount ?? 0), locale)}`
                      : `${t("upTo")} ${money(Number(bracket.upToAmount), locale)}`
                  }
                  value={percent(bracket.rateBp / 10_000, locale)}
                />
              ))}
            </dl>
          </article>
        ))
      )}
    </section>
  );
}
