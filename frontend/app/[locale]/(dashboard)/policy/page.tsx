"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Empty, Failed } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { dayOnly, money, percent } from "@/lib/format";

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

interface Draft {
  effectiveFrom: string;
  note: string;
  selfDeduction: string;
  dependentDeduction: string;
  standardDaysPerMonth: string;
  noContributionUnpaidDays: string;
  socialRateBp: string;
  healthRateBp: string;
  unemploymentRateBp: string;
  employerSocialRateBp: string;
  employerHealthRateBp: string;
  employerUnemploymentRateBp: string;
  referenceWage: string;
  socialCapMultiple: string;
  regionalMinimumWage: string;
  unemploymentCapMultiple: string;
  overtimeWeekdayBp: string;
  overtimeWeekendBp: string;
  overtimeHolidayBp: string;
  nightPremiumBp: string;
  brackets: { upToAmount: string; rate: string }[];
}

const kBpPerPercent = 100;

// A rate is stored in basis points and typed in percent: 8, not 800.
function asPercent(bp: number): string {
  return String(bp / kBpPerPercent);
}

function copyOf(policy: Policy): Draft {
  return {
    effectiveFrom: "",
    note: "",
    selfDeduction: policy.selfDeduction,
    dependentDeduction: policy.dependentDeduction,
    standardDaysPerMonth: policy.standardDaysPerMonth,
    noContributionUnpaidDays: String(policy.noContributionUnpaidDays),
    socialRateBp: asPercent(policy.socialRateBp),
    healthRateBp: asPercent(policy.healthRateBp),
    unemploymentRateBp: asPercent(policy.unemploymentRateBp),
    employerSocialRateBp: asPercent(policy.employerSocialRateBp),
    employerHealthRateBp: asPercent(policy.employerHealthRateBp),
    employerUnemploymentRateBp: asPercent(policy.employerUnemploymentRateBp),
    referenceWage: policy.referenceWage,
    socialCapMultiple: String(policy.socialCapMultiple),
    regionalMinimumWage: policy.regionalMinimumWage,
    unemploymentCapMultiple: String(policy.unemploymentCapMultiple),
    overtimeWeekdayBp: asPercent(policy.overtimeWeekdayBp),
    overtimeWeekendBp: asPercent(policy.overtimeWeekendBp),
    overtimeHolidayBp: asPercent(policy.overtimeHolidayBp),
    nightPremiumBp: asPercent(policy.nightPremiumBp),
    brackets: policy.brackets.map((one) => ({
      upToAmount: one.upToAmount ?? "",
      rate: asPercent(one.rateBp),
    })),
  };
}

function bodyOf(draft: Draft): Record<string, unknown> {
  const bp = (value: string): number => Math.round(Number(value) * kBpPerPercent);
  return {
    effectiveFrom: draft.effectiveFrom,
    note: draft.note || undefined,
    selfDeduction: Number(draft.selfDeduction),
    dependentDeduction: Number(draft.dependentDeduction),
    standardDaysPerMonth: Number(draft.standardDaysPerMonth),
    noContributionUnpaidDays: Number(draft.noContributionUnpaidDays),
    socialRateBp: bp(draft.socialRateBp),
    healthRateBp: bp(draft.healthRateBp),
    unemploymentRateBp: bp(draft.unemploymentRateBp),
    employerSocialRateBp: bp(draft.employerSocialRateBp),
    employerHealthRateBp: bp(draft.employerHealthRateBp),
    employerUnemploymentRateBp: bp(draft.employerUnemploymentRateBp),
    referenceWage: Number(draft.referenceWage),
    socialCapMultiple: Number(draft.socialCapMultiple),
    regionalMinimumWage: Number(draft.regionalMinimumWage),
    unemploymentCapMultiple: Number(draft.unemploymentCapMultiple),
    overtimeWeekdayBp: bp(draft.overtimeWeekdayBp),
    overtimeWeekendBp: bp(draft.overtimeWeekendBp),
    overtimeHolidayBp: bp(draft.overtimeHolidayBp),
    nightPremiumBp: bp(draft.nightPremiumBp),
    brackets: draft.brackets.map((one) => ({
      upToAmount: one.upToAmount === "" ? undefined : Number(one.upToAmount),
      rateBp: bp(one.rate),
    })),
  };
}

function Field({
  label,
  value,
  onChange,
  step,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  step?: string;
  suffix?: string;
}) {
  return (
    <label className="block text-xs text-(--color-muted)">
      {label}
      {suffix ? ` (${suffix})` : ""}
      <Input
        type="number"
        step={step ?? "1"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1"
      />
    </label>
  );
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
  const common = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();
  const cache = useQueryClient();
  const faultOf = useFault();
  const role = useSession((s) => s.role);
  const mayWrite = role === "ADMIN" || role === "PAYROLL";
  const [draft, setDraft] = useState<Draft | null>(null);
  const [fault, setFault] = useState<string | null>(null);

  const policies = useQuery({
    queryKey: ["payroll-policies"],
    queryFn: async () => (await api.get<Policy[]>("/payroll-policies")).data,
  });

  const add = useMutation({
    mutationFn: (one: Draft) => api.post("/payroll-policies", bodyOf(one)),
    onSuccess: () => {
      setDraft(null);
      void cache.invalidateQueries({ queryKey: ["payroll-policies"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function set(patch: Partial<Draft>): void {
    setDraft((held) => (held === null ? held : { ...held, ...patch }));
  }

  if (policies.isError) {
    return <Failed onRetry={() => policies.refetch()} />;
  }

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-(--color-muted)">{t("lead")}</p>

      {mayWrite && policies.data?.length ? (
        <Button
          type="button"
          className="mt-4 mb-6"
          onClick={() => {
            setFault(null);
            add.reset();
            setDraft(copyOf(policies.data[0]));
          }}
        >
          {t("newVersion")}
        </Button>
      ) : (
        <div className="mb-6" />
      )}

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
              {t("effectiveFrom")} {format.dateTime(dayOnly(policy.effectiveFrom), "day")}
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

      <Sheet
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={t("newVersion")}
        closeLabel={common("close")}
      >
        {draft ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              setFault(null);
              add.mutate(draft);
            }}
          >
            <p className="text-sm text-(--color-muted)">{t("copyLead")}</p>

            <label className="block text-xs text-(--color-muted)">
              {t("effectiveFrom")}
              <Input
                type="date"
                required
                value={draft.effectiveFrom}
                onChange={(event) => set({ effectiveFrom: event.target.value })}
                className="mt-1"
              />
            </label>
            <label className="block text-xs text-(--color-muted)">
              {t("note")}
              <Input
                value={draft.note}
                onChange={(event) => set({ note: event.target.value })}
                className="mt-1"
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label={t("selfDeduction")}
                value={draft.selfDeduction}
                onChange={(next) => set({ selfDeduction: next })}
              />
              <Field
                label={t("dependentDeduction")}
                value={draft.dependentDeduction}
                onChange={(next) => set({ dependentDeduction: next })}
              />
              <Field
                label={t("standardDays")}
                value={draft.standardDaysPerMonth}
                onChange={(next) => set({ standardDaysPerMonth: next })}
              />
              <Field
                label={t("unpaidDays")}
                value={draft.noContributionUnpaidDays}
                onChange={(next) => set({ noContributionUnpaidDays: next })}
              />
            </div>

            <div>
              <p className="text-sm font-medium">{t("rates")}</p>
              <div className="mt-2 grid gap-3 sm:grid-cols-3">
                <Field label={t("social")} suffix="%" step="0.01" value={draft.socialRateBp}
                  onChange={(next) => set({ socialRateBp: next })} />
                <Field label={t("health")} suffix="%" step="0.01" value={draft.healthRateBp}
                  onChange={(next) => set({ healthRateBp: next })} />
                <Field label={t("unemployment")} suffix="%" step="0.01" value={draft.unemploymentRateBp}
                  onChange={(next) => set({ unemploymentRateBp: next })} />
              </div>
            </div>

            <div>
              <p className="text-sm font-medium">{t("employerRates")}</p>
              <div className="mt-2 grid gap-3 sm:grid-cols-3">
                <Field label={t("social")} suffix="%" step="0.01" value={draft.employerSocialRateBp}
                  onChange={(next) => set({ employerSocialRateBp: next })} />
                <Field label={t("health")} suffix="%" step="0.01" value={draft.employerHealthRateBp}
                  onChange={(next) => set({ employerHealthRateBp: next })} />
                <Field label={t("unemployment")} suffix="%" step="0.01" value={draft.employerUnemploymentRateBp}
                  onChange={(next) => set({ employerUnemploymentRateBp: next })} />
              </div>
            </div>

            <div>
              <p className="text-sm font-medium">{t("caps")}</p>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <Field label={t("referenceWage")} value={draft.referenceWage}
                  onChange={(next) => set({ referenceWage: next })} />
                <Field label={t("socialCapMultiple")} value={draft.socialCapMultiple}
                  onChange={(next) => set({ socialCapMultiple: next })} />
                <Field label={t("regionalMinimumWage")} value={draft.regionalMinimumWage}
                  onChange={(next) => set({ regionalMinimumWage: next })} />
                <Field label={t("unemploymentCapMultiple")} value={draft.unemploymentCapMultiple}
                  onChange={(next) => set({ unemploymentCapMultiple: next })} />
              </div>
            </div>

            <div>
              <p className="text-sm font-medium">{t("overtimeRates")}</p>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <Field label={t("weekday")} suffix="%" step="0.01" value={draft.overtimeWeekdayBp}
                  onChange={(next) => set({ overtimeWeekdayBp: next })} />
                <Field label={t("weekend")} suffix="%" step="0.01" value={draft.overtimeWeekendBp}
                  onChange={(next) => set({ overtimeWeekendBp: next })} />
                <Field label={t("holiday")} suffix="%" step="0.01" value={draft.overtimeHolidayBp}
                  onChange={(next) => set({ overtimeHolidayBp: next })} />
                <Field label={t("night")} suffix="%" step="0.01" value={draft.nightPremiumBp}
                  onChange={(next) => set({ nightPremiumBp: next })} />
              </div>
            </div>

            <div>
              <p className="text-sm font-medium">{t("brackets")}</p>
              <ul className="mt-2 flex flex-col gap-2">
                {draft.brackets.map((bracket, index) => (
                  <li key={index} className="flex flex-wrap items-end gap-2">
                    <div className="min-w-40 flex-1">
                      <Field
                        label={index === draft.brackets.length - 1 ? t("noCeiling") : t("upTo")}
                        value={bracket.upToAmount}
                        onChange={(next) =>
                          set({
                            brackets: draft.brackets.map((one, at) =>
                              at === index ? { ...one, upToAmount: next } : one,
                            ),
                          })
                        }
                      />
                    </div>
                    <div className="w-28">
                      <Field
                        label={t("rate")}
                        suffix="%"
                        step="0.01"
                        value={bracket.rate}
                        onChange={(next) =>
                          set({
                            brackets: draft.brackets.map((one, at) =>
                              at === index ? { ...one, rate: next } : one,
                            ),
                          })
                        }
                      />
                    </div>
                    <Button
                      type="button"
                      tone="quiet"
                      size="sm"
                      onClick={() =>
                        set({ brackets: draft.brackets.filter((_, at) => at !== index) })
                      }
                    >
                      {t("dropBracket")}
                    </Button>
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                tone="quiet"
                size="sm"
                className="mt-2"
                onClick={() =>
                  set({ brackets: [...draft.brackets, { upToAmount: "", rate: "" }] })
                }
              >
                {t("addBracket")}
              </Button>
            </div>

            {fault ? (
              <p role="alert" className="text-sm text-(--color-danger)">
                {fault}
              </p>
            ) : null}

            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? common("saving") : common("save")}
            </Button>
          </form>
        ) : null}
      </Sheet>
    </section>
  );
}
