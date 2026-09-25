"use client";

import { Button, Collapsible, Empty, Input, LayerCard, LayerDialog, SkeletonLine } from "@cloudflare/kumo";
import { CaretDownIcon, PlusIcon, ScalesIcon, XIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, Facts, PageHeader, PageLayout, StatList } from "@/components/ui/page";
import { StatePill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
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

type NumberField = Exclude<keyof Draft, "effectiveFrom" | "note" | "brackets">;

const kBpPerPercent = 100;
const kBpWhole = 10_000;

function firstOfNextMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

function today(): string {
  const now = new Date();
  const pad = (one: number) => String(one).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// A rate is stored in basis points and typed in percent: 8, not 800.
function asPercent(bp: number): string {
  return String(bp / kBpPerPercent);
}

function copyOf(policy: Policy | undefined): Draft {
  return {
    effectiveFrom: firstOfNextMonth(),
    note: "",
    selfDeduction: policy?.selfDeduction ?? "",
    dependentDeduction: policy?.dependentDeduction ?? "",
    standardDaysPerMonth: policy?.standardDaysPerMonth ?? "",
    noContributionUnpaidDays: policy ? String(policy.noContributionUnpaidDays) : "",
    socialRateBp: policy ? asPercent(policy.socialRateBp) : "",
    healthRateBp: policy ? asPercent(policy.healthRateBp) : "",
    unemploymentRateBp: policy ? asPercent(policy.unemploymentRateBp) : "",
    employerSocialRateBp: policy ? asPercent(policy.employerSocialRateBp) : "",
    employerHealthRateBp: policy ? asPercent(policy.employerHealthRateBp) : "",
    employerUnemploymentRateBp: policy ? asPercent(policy.employerUnemploymentRateBp) : "",
    referenceWage: policy?.referenceWage ?? "",
    socialCapMultiple: policy ? String(policy.socialCapMultiple) : "",
    regionalMinimumWage: policy?.regionalMinimumWage ?? "",
    unemploymentCapMultiple: policy ? String(policy.unemploymentCapMultiple) : "",
    overtimeWeekdayBp: policy ? asPercent(policy.overtimeWeekdayBp) : "",
    overtimeWeekendBp: policy ? asPercent(policy.overtimeWeekendBp) : "",
    overtimeHolidayBp: policy ? asPercent(policy.overtimeHolidayBp) : "",
    nightPremiumBp: policy ? asPercent(policy.nightPremiumBp) : "",
    brackets: (policy?.brackets ?? []).map((one) => ({ upToAmount: one.upToAmount ?? "", rate: asPercent(one.rateBp) })),
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

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="m-0 font-semibold">{title}</h3>
      {children}
    </div>
  );
}

/** Every figure of one version, grouped the way the law groups them. */
function PolicyDetail({ policy }: { policy: Policy }) {
  const t = useTranslations("policy");
  const locale = useLocale();
  const cash = (value: string | number) => <span className="tabular-nums">{money(Number(value), locale)}</span>;
  const rate = (bp: number) => <span className="tabular-nums">{percent(bp / kBpWhole, locale)}</span>;

  return (
    <div className="flex flex-col gap-5">
      {policy.note ? <p className="text-kumo-subtle">{policy.note}</p> : null}
      <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
        <Group title={t("deductionsDays")}>
          <Facts
            rows={[
              [t("selfDeduction"), cash(policy.selfDeduction)],
              [t("dependentDeduction"), cash(policy.dependentDeduction)],
              [t("standardDays"), <span key="d" className="tabular-nums">{policy.standardDaysPerMonth}</span>],
              [t("unpaidDays"), <span key="u" className="tabular-nums">{policy.noContributionUnpaidDays}</span>],
            ]}
          />
        </Group>
        <Group title={t("caps")}>
          <Facts
            rows={[
              [t("referenceWage"), cash(policy.referenceWage)],
              [t("socialCap"), cash(Number(policy.referenceWage) * policy.socialCapMultiple)],
              [t("regionalMinimumWage"), cash(policy.regionalMinimumWage)],
              [t("unemploymentCap"), cash(Number(policy.regionalMinimumWage) * policy.unemploymentCapMultiple)],
            ]}
          />
        </Group>
        <Group title={t("rates")}>
          <Facts
            rows={[
              [t("social"), rate(policy.socialRateBp)],
              [t("health"), rate(policy.healthRateBp)],
              [t("unemployment"), rate(policy.unemploymentRateBp)],
            ]}
          />
        </Group>
        <Group title={t("employerRates")}>
          <Facts
            rows={[
              [t("social"), rate(policy.employerSocialRateBp)],
              [t("health"), rate(policy.employerHealthRateBp)],
              [t("unemployment"), rate(policy.employerUnemploymentRateBp)],
            ]}
          />
        </Group>
        <Group title={t("overtimeRates")}>
          <Facts
            rows={[
              [t("weekday"), rate(policy.overtimeWeekdayBp)],
              [t("weekend"), rate(policy.overtimeWeekendBp)],
              [t("holiday"), rate(policy.overtimeHolidayBp)],
              [t("night"), rate(policy.nightPremiumBp)],
            ]}
          />
        </Group>
        <Group title={t("brackets")}>
          <Facts
            rows={policy.brackets.map((bracket): [string, ReactNode] => [
              bracket.upToAmount === null
                ? `${t("over")} ${money(Number(policy.brackets.at(-2)?.upToAmount ?? 0), locale)}`
                : `${t("upTo")} ${money(Number(bracket.upToAmount), locale)}`,
              rate(bracket.rateBp),
            ])}
          />
        </Group>
      </div>
    </div>
  );
}

export default function PolicyPage() {
  const t = useTranslations("policy");
  const common = useTranslations("common");
  const format = useFormatter();
  const cache = useQueryClient();
  const notify = useNotify();
  const faultOf = useFault();
  const role = useSession((s) => s.role);
  const mayWrite = role === "ADMIN" || role === "PAYROLL";
  const [draft, setDraft] = useState<Draft | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());

  const policies = useQuery({
    queryKey: ["payroll-policies"],
    queryFn: async () => (await api.get<Policy[]>("/payroll-policies")).data,
  });

  const add = useMutation({
    mutationFn: (one: Draft) => api.post("/payroll-policies", bodyOf(one)),
    onSuccess: (_, one) => {
      setDraft(null);
      notify.done(t("added", { date: format.dateTime(dayOnly(one.effectiveFrom), "day") }));
      void cache.invalidateQueries({ queryKey: ["payroll-policies"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const sorted = [...(policies.data ?? [])].sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom));
  const now = today();
  const inForce = sorted.find((one) => one.effectiveFrom.slice(0, 10) <= now);
  const others = sorted.filter((one) => one !== inForce);
  const since = (one: Policy) => t("effectiveOn", { date: format.dateTime(dayOnly(one.effectiveFrom), "day") });
  const scheduled = (one: Policy) => one.effectiveFrom.slice(0, 10) > now;

  function set(patch: Partial<Draft>): void {
    setDraft((held) => (held === null ? held : { ...held, ...patch }));
  }

  function startDraft(): void {
    setFault(null);
    setDraft(copyOf(inForce ?? sorted[0]));
  }

  function fold(id: string, open: boolean): void {
    const next = new Set(unfolded);
    if (open) {
      next.add(id);
    } else {
      next.delete(id);
    }
    setUnfolded(next);
  }

  function show(one: Policy): void {
    if (one !== inForce) {
      fold(one.id, true);
    }
    document.getElementById(`policy-${one.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const numberField = (field: NumberField, label: string, suffix?: string) => (
    <Input
      label={suffix ? `${label} (${suffix})` : label}
      type="number"
      step={suffix === "%" ? "0.01" : "1"}
      value={draft?.[field] ?? ""}
      onChange={(event) => set({ [field]: event.target.value })}
      className="w-full min-w-0"
    />
  );

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("leadShort")}
        actions={
          mayWrite && !policies.isPending ? (
            <Button variant="primary" icon={PlusIcon} onClick={startDraft}>
              {t("newVersion")}
            </Button>
          ) : undefined
        }
      />

      <PageLayout
        aside={
          sorted.length > 0 ? (
            <AsideCard title={t("versions")}>
              <StatList
                stats={sorted.map((one) => ({
                  key: one.id,
                  label: since(one),
                  value:
                    one === inForce ? (
                      <StatePill tone="good">{t("inForce")}</StatePill>
                    ) : scheduled(one) ? (
                      <StatePill tone="waiting">{t("scheduled")}</StatePill>
                    ) : (
                      <StatePill>{t("superseded")}</StatePill>
                    ),
                  active: one === inForce ? false : unfolded.has(one.id),
                  onPick: () => show(one),
                }))}
              />
            </AsideCard>
          ) : undefined
        }
        extra={
          <AsideCard title={common("goodToKnow")}>
            <p className="text-pretty text-kumo-subtle">{t("versionRule")}</p>
          </AsideCard>
        }
      >
        {policies.isError ? (
          <Failed onRetry={() => void policies.refetch()} />
        ) : policies.isPending ? (
          <LayerCard className="flex flex-col gap-3 p-4">
            {Array.from({ length: 5 }, (_, at) => (
              <SkeletonLine key={at} minWidth={27} maxWidth={70} />
            ))}
          </LayerCard>
        ) : sorted.length === 0 ? (
          <LayerCard className="p-0">
            <Empty
              icon={<ScalesIcon size={40} className="text-kumo-inactive" />}
              title={t("empty")}
              description={mayWrite ? t("emptyHint") : undefined}
              contents={
                mayWrite ? (
                  <Button variant="primary" icon={PlusIcon} onClick={startDraft}>
                    {t("newVersion")}
                  </Button>
                ) : undefined
              }
              className="py-12"
            />
          </LayerCard>
        ) : (
          <div className="flex flex-col gap-8">
            {inForce ? (
              <LayerCard id={`policy-${inForce.id}`} className="scroll-mt-24">
                <LayerCard.Secondary className="justify-between">
                  <span>{since(inForce)}</span>
                  <StatePill tone="good">{t("inForce")}</StatePill>
                </LayerCard.Secondary>
                <LayerCard.Primary>
                  <PolicyDetail policy={inForce} />
                </LayerCard.Primary>
              </LayerCard>
            ) : null}

            {others.length > 0 ? (
              <section className="flex flex-col gap-3">
                <h2 className="m-0 text-lg font-semibold">{t("otherVersions")}</h2>
                {others.map((one) => {
                  const open = unfolded.has(one.id);
                  return (
                    <Collapsible.Root
                      key={one.id}
                      open={open}
                      onOpenChange={(next) => fold(one.id, next)}
                      render={<LayerCard id={`policy-${one.id}`} className="scroll-mt-24" />}
                    >
                      <LayerCard.Secondary className={cn("p-0", !open && "my-0")}>
                        <Collapsible.Trigger className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-3 text-start">
                          <span className="flex min-w-0 flex-col">
                            <span>{since(one)}</span>
                            {one.note && !open ? <span className="truncate text-sm font-normal">{one.note}</span> : null}
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {scheduled(one) ? (
                              <StatePill tone="waiting">{t("scheduled")}</StatePill>
                            ) : (
                              <StatePill>{t("superseded")}</StatePill>
                            )}
                            <CaretDownIcon size={14} className={cn("transition-transform", open && "rotate-180")} aria-hidden />
                          </span>
                        </Collapsible.Trigger>
                      </LayerCard.Secondary>
                      <Collapsible.Panel render={<LayerCard.Primary />}>
                        <PolicyDetail policy={one} />
                      </Collapsible.Panel>
                    </Collapsible.Root>
                  );
                })}
              </section>
            ) : null}
          </div>
        )}
      </PageLayout>

      <LayerDialog.Root open={draft !== null} onOpenChange={(next) => !next && setDraft(null)} dismissDisabled={add.isPending}>
        <LayerDialog.Content size="lg" closeLabel={common("close")}>
          <LayerDialog.Title>{t("newVersion")}</LayerDialog.Title>
          <LayerDialog.Description>{inForce ? t("copyLead") : t("blankLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            {draft ? (
              <div className="flex flex-col gap-6">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input
                    label={t("effectiveFrom")}
                    type="date"
                    required
                    value={draft.effectiveFrom}
                    onChange={(event) => set({ effectiveFrom: event.target.value })}
                  />
                  <Input label={t("note")} value={draft.note} onChange={(event) => set({ note: event.target.value })} />
                </div>

                <Group title={t("deductionsDays")}>
                  <div className="mt-2 grid gap-4 sm:grid-cols-2">
                    {numberField("selfDeduction", t("selfDeduction"))}
                    {numberField("dependentDeduction", t("dependentDeduction"))}
                    {numberField("standardDaysPerMonth", t("standardDays"))}
                    {numberField("noContributionUnpaidDays", t("unpaidDays"))}
                  </div>
                </Group>

                <Group title={t("rates")}>
                  <div className="mt-2 grid gap-4 sm:grid-cols-3">
                    {numberField("socialRateBp", t("social"), "%")}
                    {numberField("healthRateBp", t("health"), "%")}
                    {numberField("unemploymentRateBp", t("unemployment"), "%")}
                  </div>
                </Group>

                <Group title={t("employerRates")}>
                  <div className="mt-2 grid gap-4 sm:grid-cols-3">
                    {numberField("employerSocialRateBp", t("social"), "%")}
                    {numberField("employerHealthRateBp", t("health"), "%")}
                    {numberField("employerUnemploymentRateBp", t("unemployment"), "%")}
                  </div>
                </Group>

                <Group title={t("caps")}>
                  <div className="mt-2 grid gap-4 sm:grid-cols-2">
                    {numberField("referenceWage", t("referenceWage"))}
                    {numberField("socialCapMultiple", t("socialCapMultiple"))}
                    {numberField("regionalMinimumWage", t("regionalMinimumWage"))}
                    {numberField("unemploymentCapMultiple", t("unemploymentCapMultiple"))}
                  </div>
                </Group>

                <Group title={t("overtimeRates")}>
                  <div className="mt-2 grid gap-4 sm:grid-cols-2">
                    {numberField("overtimeWeekdayBp", t("weekday"), "%")}
                    {numberField("overtimeWeekendBp", t("weekend"), "%")}
                    {numberField("overtimeHolidayBp", t("holiday"), "%")}
                    {numberField("nightPremiumBp", t("night"), "%")}
                  </div>
                </Group>

                <Group title={t("brackets")}>
                  <ul className="mt-2 flex flex-col gap-3">
                    {draft.brackets.map((bracket, index) => (
                      <li key={index} className="flex items-end gap-2">
                        <div className="min-w-0 flex-1">
                          <Input
                            label={index === draft.brackets.length - 1 ? t("noCeiling") : t("upTo")}
                            type="number"
                            value={bracket.upToAmount}
                            onChange={(event) =>
                              set({
                                brackets: draft.brackets.map((one, at) =>
                                  at === index ? { ...one, upToAmount: event.target.value } : one,
                                ),
                              })
                            }
                          />
                        </div>
                        <div className="w-28 shrink-0">
                          <Input
                            label={`${t("rate")} (%)`}
                            type="number"
                            step="0.01"
                            value={bracket.rate}
                            onChange={(event) =>
                              set({
                                brackets: draft.brackets.map((one, at) => (at === index ? { ...one, rate: event.target.value } : one)),
                              })
                            }
                          />
                        </div>
                        <Button
                          variant="ghost"
                          shape="square"
                          icon={XIcon}
                          aria-label={t("dropBracket")}
                          onClick={() => set({ brackets: draft.brackets.filter((_, at) => at !== index) })}
                        />
                      </li>
                    ))}
                  </ul>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={PlusIcon}
                    className="mt-3 self-start"
                    onClick={() => set({ brackets: [...draft.brackets, { upToAmount: "", rate: "" }] })}
                  >
                    {t("addBracket")}
                  </Button>
                </Group>

                {fault ? <p className="text-kumo-danger">{fault}</p> : null}
              </div>
            ) : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              loading={add.isPending}
              disabled={!draft?.effectiveFrom}
              onClick={() => {
                if (draft) {
                  setFault(null);
                  add.mutate(draft);
                }
              }}
            >
              {t("saveVersion")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}
