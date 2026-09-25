"use client";

import { Button, Input, LayerDialog, SkeletonLine } from "@cloudflare/kumo";
import { PlusIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { MonthPicker, shiftMonth, thisMonth, type Month } from "@/components/ui/month-picker";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill, type Tone } from "@/components/ui/pill";
import { Link, useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { dayOnly } from "@/lib/format";

interface Period {
  id: string;
  year: number;
  month: number;
  state: "OPEN" | "LOCKED" | "PAID";
  payDate: string | null;
  lockedAt: string | null;
  paidAt: string | null;
}

interface Run {
  kind: "REGULAR" | "BONUS" | "FINAL_SETTLEMENT";
  state: "DRAFT" | "RUNNING" | "DONE" | "FAILED" | "DISCARDED";
}

const TONE: Record<Period["state"], Tone> = { OPEN: "waiting", LOCKED: "idle", PAID: "good" };

const STATE_KEY: Record<Period["state"], "stateOPEN" | "stateLOCKED" | "statePAID"> = {
  OPEN: "stateOPEN",
  LOCKED: "stateLOCKED",
  PAID: "statePAID",
};

const STEPS = ["run", "check", "lock", "pay", "deliver"] as const;

const STEP_KEY = {
  run: { name: "stepRun", hint: "stepRunHint" },
  check: { name: "stepCheck", hint: "stepCheckHint" },
  lock: { name: "stepLock", hint: "stepLockHint" },
  pay: { name: "stepPay", hint: "stepPayHint" },
  deliver: { name: "stepDeliver", hint: "stepDeliverHint" },
} as const;

function periodName(period: { year: number; month: number }): string {
  return `${String(period.month).padStart(2, "0")}/${period.year}`;
}

function order(at: { year: number; month: number }): number {
  return at.year * 12 + at.month;
}

/** This month, or the month after the newest period when this one is already open. */
function nextToOpen(periods: Period[]): Month {
  const now = thisMonth();
  if (!periods.some((one) => one.year === now.year && one.month === now.month)) {
    return now;
  }
  const newest = periods.reduce((best, one) => (order(one) > order(best) ? one : best), periods[0]);
  return shiftMonth({ year: newest.year, month: newest.month }, 1);
}

export default function PayrollPage() {
  const t = useTranslations("payroll");
  const common = useTranslations("common");
  const format = useFormatter();
  const role = useSession((s) => s.role);
  const cache = useQueryClient();
  const router = useRouter();
  const notify = useNotify();
  const faultOf = useFault();
  const mayWrite = role === "ADMIN" || role === "PAYROLL";

  const [opening, setOpening] = useState(false);
  const [month, setMonth] = useState<Month>(thisMonth);
  const [payDate, setPayDate] = useState("");
  const [fault, setFault] = useState<string | null>(null);

  const periods = useQuery({
    queryKey: ["payroll-periods"],
    queryFn: async () => (await api.get<Period[]>("/payroll-periods")).data,
  });
  const openPeriod = periods.data?.find((one) => one.state === "OPEN");

  const openRuns = useQuery({
    queryKey: ["payroll-periods", openPeriod?.id, "runs"],
    enabled: openPeriod !== undefined,
    queryFn: async () => (await api.get<Run[]>(`/payroll-periods/${openPeriod?.id}/runs`)).data,
  });

  const open = useMutation({
    mutationFn: async () =>
      (await api.post<Period>("/payroll-periods", { year: month.year, month: month.month, payDate: payDate || undefined }))
        .data,
    onSuccess: (made) => {
      setOpening(false);
      notify.done(t("periodOpened", { period: periodName(made) }));
      void cache.invalidateQueries({ queryKey: ["payroll-periods"] });
      router.push(`/payroll/${made.id}`);
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function startOpening(): void {
    setFault(null);
    setPayDate("");
    setMonth(nextToOpen(periods.data ?? []));
    setOpening(true);
  }

  const columns: Column<Period>[] = [
    {
      id: "period",
      header: t("period"),
      sticky: true,
      sortBy: (row) => order(row),
      cell: (row) => <span className="font-medium tabular-nums">{periodName(row)}</span>,
    },
    {
      id: "state",
      header: t("state"),
      sortBy: (row) => row.state,
      cell: (row) => <StatePill tone={TONE[row.state]}>{t(STATE_KEY[row.state])}</StatePill>,
    },
    {
      id: "lockedAt",
      header: t("lockedAt"),
      cell: (row) => (row.lockedAt ? format.dateTime(new Date(row.lockedAt), "day") : common("empty")),
    },
    {
      id: "payDate",
      header: t("payDate"),
      sortBy: (row) => row.payDate ?? "",
      cell: (row) => (row.payDate ? format.dateTime(dayOnly(row.payDate), "day") : common("empty")),
    },
  ];

  const hasRegular = (openRuns.data ?? []).some((run) => run.kind === "REGULAR" && run.state === "DONE");
  const openStep = hasRegular ? "check" : "run";

  return (
    <>
      <PageHeader
        title={t("periodsTitle")}
        description={t("periodsLead")}
        actions={
          mayWrite ? (
            <Button variant="primary" icon={PlusIcon} onClick={startOpening} disabled={periods.isPending}>
              {t("openPeriod")}
            </Button>
          ) : undefined
        }
      />

      <PageLayout
        aside={
          <AsideCard title={t("openNow")}>
            {periods.isPending ? (
              <SkeletonLine minWidth={120} maxWidth={240} />
            ) : openPeriod ? (
              <div className="flex flex-col gap-3">
                <Facts
                  rows={[
                    [t("period"), <span key="p" className="font-medium tabular-nums">{periodName(openPeriod)}</span>],
                    [
                      t("stepNow"),
                      openRuns.isPending ? common("empty") : t(STEP_KEY[openStep].name),
                    ],
                  ]}
                />
                <Link href={`/payroll/${openPeriod.id}`} className="text-kumo-link hover:underline">
                  {t("openThePeriod", { period: periodName(openPeriod) })}
                </Link>
              </div>
            ) : (
              <p className="text-kumo-subtle">{t("openNone")}</p>
            )}
          </AsideCard>
        }
        extra={
          <AsideCard title={t("stepsTitle")}>
            <ol className="flex flex-col gap-3">
              {STEPS.map((step, at) => (
                <li key={step} className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-kumo-tint text-sm font-medium tabular-nums">
                    {at + 1}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium">{t(STEP_KEY[step].name)}</span>
                    <span className="text-sm text-pretty text-kumo-subtle">{t(STEP_KEY[step].hint)}</span>
                  </span>
                </li>
              ))}
            </ol>
          </AsideCard>
        }
      >
        <DataTable
          id="payroll-periods"
          cardLead="period"
          columns={columns}
          rows={periods.data}
          keyOf={(row) => row.id}
          pending={periods.isPending}
          failed={periods.isError}
          onRetry={() => void periods.refetch()}
          rowHref={(row) => `/payroll/${row.id}`}
          empty={t("periodsEmpty")}
          emptyHint={mayWrite ? t("periodsEmptyHint") : undefined}
          emptyAction={
            mayWrite ? (
              <Button variant="primary" icon={PlusIcon} onClick={startOpening}>
                {t("openPeriod")}
              </Button>
            ) : undefined
          }
        />
      </PageLayout>

      <LayerDialog.Root open={opening} onOpenChange={setOpening} dismissDisabled={open.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("openPeriod")}</LayerDialog.Title>
          <LayerDialog.Description>{t("openPeriodLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <span className="font-medium">{t("month")}</span>
                <MonthPicker value={month} onChange={setMonth} />
              </div>
              <Input
                label={t("payDate")}
                type="date"
                value={payDate}
                description={t("payDateHint")}
                onChange={(event) => setPayDate(event.target.value)}
              />
              {fault ? <p className="text-kumo-danger">{fault}</p> : null}
            </div>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary loading={open.isPending} onClick={() => open.mutate()}>
              {t("openPeriodN", { period: periodName(month) })}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}
