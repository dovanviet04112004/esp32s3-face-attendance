"use client";

import { Banner, Button, Empty, LayerCard, LayerDialog, Select, SkeletonLine, Textarea } from "@cloudflare/kumo";
import { ChatCircleTextIcon, PrinterIcon, ReceiptIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Suspense, useState, type FormEvent } from "react";

import { DisputeCard, type Dispute } from "@/components/payroll/dispute-card";
import { PayslipView, useLineName, type Payslip } from "@/components/payroll/payslip-view";
import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, Facts, PageHeader, PageLayout, StatList } from "@/components/ui/page";
import { useRouter } from "@/i18n/navigation";
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

interface PayslipPage {
  rows: PayslipRow[];
  total: number;
  next: string | null;
}

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

const kHere = "/me/payslips";
const kDisputeForm = "dispute-form";
const THIS_YEAR = new Date().getFullYear();
const YEARS = [THIS_YEAR, THIS_YEAR - 1, THIS_YEAR - 2];

function periodName(row: PayslipRow, fallback: string): string {
  return row.period ? `${String(row.period.month).padStart(2, "0")}/${row.period.year}` : fallback;
}

function Waiting({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: lines }, (_, at) => (
        <SkeletonLine key={at} minWidth={25} maxWidth={47} />
      ))}
    </div>
  );
}

function MyPayslips() {
  const t = useTranslations("payroll");
  const d = useTranslations("disputes");
  const common = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const search = useSearchParams();
  const nameOf = useLineName();
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();
  const employeeId = useSession((one) => one.employeeId);
  const [year, setYear] = useState(THIS_YEAR);
  const [raising, setRaising] = useState(false);
  const [claim, setClaim] = useState("");
  const [lineCode, setLineCode] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState<Dispute | null>(null);

  const mine = useInfiniteQuery({
    queryKey: ["payslips", "mine", employeeId],
    enabled: employeeId !== null,
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const after = pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : "";
      return (await api.get<PayslipPage>(`/payslips?employeeId=${employeeId}${after}`)).data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const slips = mine.data?.pages.flatMap((one) => one.rows);
  const asked = search.get("slip");
  const chosen = (asked && slips?.some((one) => one.id === asked) ? asked : null) ?? slips?.[0]?.id ?? null;
  const chosenRow = slips?.find((one) => one.id === chosen);

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

  const statement = useQuery({
    queryKey: ["tax-year", employeeId, year],
    enabled: employeeId !== null,
    queryFn: async () => (await api.get<TaxYear>(`/tax-year/${employeeId}?year=${year}`)).data,
  });

  const raise = useMutation({
    mutationFn: async () =>
      api.post("/payslip-disputes", { payslipId: chosen, claim, ...(lineCode === "" ? {} : { lineCode }) }),
    onSuccess: () => {
      notify.done(d("raised"));
      setRaising(false);
      void cache.invalidateQueries({ queryKey: ["payslip-disputes"] });
    },
    onError: (fell: unknown) => setRefused(faultOf(fell)),
  });

  const withdraw = useMutation({
    mutationFn: async (id: string) => api.post(`/payslip-disputes/${id}/withdraw`, {}),
    onSuccess: () => {
      notify.done(d("withdrawn"));
      setWithdrawing(null);
      void cache.invalidateQueries({ queryKey: ["payslip-disputes"] });
    },
    onError: (fell: unknown) => {
      notify.failed(fell);
      setWithdrawing(null);
    },
  });

  function choose(id: string): void {
    router.replace(`${kHere}?slip=${id}`, { scroll: false });
  }

  function openRaise(): void {
    setClaim("");
    setLineCode("");
    setRefused(null);
    setRaising(true);
  }

  const onThisSlip = (disputes.data ?? []).filter((one) => one.payslipId === chosen);
  const disputable = slip.data !== undefined && slip.data.state !== "DRAFT";
  const periodItems = Object.fromEntries((slips ?? []).map((row) => [row.id, periodName(row, t("period"))]));
  const moreSlips = mine.hasNextPage ? (
    <Button variant="ghost" size="sm" className="mt-2 w-full" loading={mine.isFetchingNextPage} onClick={() => void mine.fetchNextPage()}>
      {common("loadMore")}
    </Button>
  ) : null;

  const taxRows: [string, string][] = statement.data
    ? [
        [t("taxGross"), statement.data.grossTotal],
        [t("taxInsurance"), statement.data.insuranceTotal],
        [t("taxReliefSelf"), statement.data.reliefSelfTotal],
        [t("taxReliefDependent"), statement.data.reliefDependentTotal],
        [t("taxExemptOvertime"), statement.data.exemptOvertimeTotal],
        [t("taxAssessable"), statement.data.assessableTotal],
        [t("taxDue"), statement.data.taxDue],
        [t("taxWithheld"), statement.data.taxWithheld],
        [t("taxDifference"), statement.data.difference],
      ]
    : [];

  const hasSlips = (slips?.length ?? 0) > 0;

  return (
    <>
      <PageHeader
        title={t("myTitle")}
        description={t("myLead")}
        actions={
          slip.data ? (
            <Button variant="secondary" icon={PrinterIcon} onClick={() => window.print()}>
              {t("printSlip")}
            </Button>
          ) : undefined
        }
      />

      <PageLayout
        aside={
          hasSlips ? (
            <div className="hidden md:block">
              <AsideCard title={t("periods")}>
                <div className="max-h-96 overflow-y-auto">
                  <StatList
                    stats={(slips ?? []).map((row) => ({
                      key: row.id,
                      label: periodName(row, t("period")),
                      value: money(Number(row.netPay), locale),
                      active: row.id === chosen,
                      onPick: () => choose(row.id),
                    }))}
                  />
                </div>
                {moreSlips}
              </AsideCard>
            </div>
          ) : undefined
        }
        extra={
          <AsideCard
            title={t("taxYearTitle")}
            action={
              <Select
                aria-label={t("taxYear")}
                size="sm"
                value={String(year)}
                onValueChange={(next) => setYear(Number(next ?? THIS_YEAR))}
                items={Object.fromEntries(YEARS.map((one) => [String(one), String(one)]))}
              />
            }
          >
            {statement.isPending ? (
              <Waiting lines={4} />
            ) : statement.isError ? (
              <Failed onRetry={() => void statement.refetch()} />
            ) : !statement.data || statement.data.months.length === 0 ? (
              <p className="text-kumo-subtle">{t("taxYearEmpty")}</p>
            ) : (
              <>
                <p className="mb-2 text-kumo-subtle">{t("taxYearLead")}</p>
                <Facts
                  rows={taxRows.map(([label, value]) => [
                    label,
                    <span key={label} className="tabular-nums">
                      {money(Number(value), locale)}
                    </span>,
                  ])}
                />
                <p className="mt-2 text-sm text-kumo-subtle">{t("taxYearMonths", { count: statement.data.months.length })}</p>
              </>
            )}
          </AsideCard>
        }
      >
        {mine.isError ? (
          <Failed onRetry={() => void mine.refetch()} />
        ) : mine.isPending ? (
          <LayerCard className="p-4">
            <Waiting lines={6} />
          </LayerCard>
        ) : !hasSlips ? (
          <LayerCard className="p-0">
            <Empty
              icon={<ReceiptIcon size={40} className="text-kumo-inactive" />}
              title={t("empty")}
              description={t("myEmptyHint")}
              className="py-12"
            />
          </LayerCard>
        ) : (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2 md:hidden">
              <Select
                label={t("period")}
                hideLabel={false}
                className="w-full"
                value={chosen ?? ""}
                onValueChange={(next) => next && choose(String(next))}
                items={periodItems}
              />
              {moreSlips}
            </div>

            <section className="flex flex-col gap-3" aria-label={chosenRow ? periodName(chosenRow, t("period")) : t("period")}>
              <h2 className="m-0 hidden text-lg font-semibold md:block">
                {t("periodOf", { period: chosenRow ? periodName(chosenRow, t("period")) : common("empty") })}
              </h2>
              <div data-print>
                {slip.isError ? (
                  <Failed onRetry={() => void slip.refetch()} />
                ) : slip.data ? (
                  <PayslipView slip={slip.data} />
                ) : (
                  <LayerCard className="p-4">
                    <Waiting lines={6} />
                  </LayerCard>
                )}
              </div>
            </section>

            {delta.data && delta.data.length > 0 ? (
              <LayerCard>
                <LayerCard.Secondary>{t("compare")}</LayerCard.Secondary>
                <LayerCard.Primary>
                  <Facts
                    rows={delta.data.map((row) => [
                      nameOf(row.code),
                      <span
                        key={row.code}
                        className={cn("tabular-nums", Number(row.difference) < 0 ? "text-kumo-danger" : "text-kumo-success")}
                      >
                        {Number(row.difference) > 0 ? "+" : ""}
                        {money(Number(row.difference), locale)}
                      </span>,
                    ])}
                  />
                </LayerCard.Primary>
              </LayerCard>
            ) : null}

            {disputable ? (
              <LayerCard>
                <LayerCard.Secondary className="justify-between gap-3">
                  <span>{d("title")}</span>
                  {onThisSlip.length > 0 ? (
                    <Button variant="secondary" size="sm" icon={ChatCircleTextIcon} onClick={openRaise}>
                      {d("raise")}
                    </Button>
                  ) : null}
                </LayerCard.Secondary>
                <LayerCard.Primary>
                  {disputes.isPending ? (
                    <Waiting />
                  ) : disputes.isError ? (
                    <Failed onRetry={() => void disputes.refetch()} />
                  ) : onThisSlip.length === 0 ? (
                    <Empty
                      size="sm"
                      icon={<ChatCircleTextIcon size={32} className="text-kumo-inactive" />}
                      title={d("empty")}
                      description={d("lead")}
                      contents={
                        <Button variant="secondary" icon={ChatCircleTextIcon} onClick={openRaise}>
                          {d("raise")}
                        </Button>
                      }
                    />
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {onThisSlip.map((one) => (
                        <DisputeCard
                          key={one.id}
                          dispute={one}
                          busy={withdraw.isPending && withdraw.variables === one.id}
                          onWithdraw={() => setWithdrawing(one)}
                        />
                      ))}
                    </ul>
                  )}
                </LayerCard.Primary>
              </LayerCard>
            ) : null}
          </div>
        )}
      </PageLayout>

      <LayerDialog.Root open={raising} onOpenChange={setRaising} dismissDisabled={raise.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{d("raise")}</LayerDialog.Title>
          <LayerDialog.Description>
            {chosenRow ? d("raiseLead", { period: periodName(chosenRow, t("period")) }) : d("lead")}
          </LayerDialog.Description>
          <LayerDialog.Body>
            <form
              id={kDisputeForm}
              className="flex flex-col gap-4"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                setRefused(null);
                raise.mutate();
              }}
            >
              <Select
                label={d("line")}
                hideLabel={false}
                className="w-full"
                value={lineCode}
                onValueChange={(next) => setLineCode(String(next ?? ""))}
                items={{
                  "": d("lineAny"),
                  ...Object.fromEntries((slip.data?.lines ?? []).map((one) => [one.code, nameOf(one.code, one.label)])),
                }}
              />
              <Textarea
                label={d("claim")}
                placeholder={d("claimHint")}
                required
                rows={3}
                maxLength={2000}
                value={claim}
                onValueChange={setClaim}
              />
              {refused ? <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title={refused} /> : null}
            </form>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary type="submit" form={kDisputeForm} loading={raise.isPending}>
              {d("raise")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Alert
        open={withdrawing !== null}
        onOpenChange={(next) => !next && setWithdrawing(null)}
        dismissDisabled={withdraw.isPending}
      >
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{d("withdrawTitle")}</LayerDialog.Title>
          <LayerDialog.Description>
            {withdrawing
              ? d("withdrawLead", { line: withdrawing.lineCode ? nameOf(withdrawing.lineCode) : d("lineAny") })
              : ""}
          </LayerDialog.Description>
          <LayerDialog.Body>
            {withdrawing ? <p className="line-clamp-3 text-kumo-subtle">{withdrawing.claim}</p> : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("back")}>
            <LayerDialog.Actions.Primary
              variant="destructive"
              loading={withdraw.isPending}
              onClick={() => withdrawing && withdraw.mutate(withdrawing.id)}
            >
              {d("withdraw")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </>
  );
}

// The chosen period rides on the query string, which the prerender does not have.
export default function MyPayslipsPage() {
  return (
    <Suspense>
      <MyPayslips />
    </Suspense>
  );
}
