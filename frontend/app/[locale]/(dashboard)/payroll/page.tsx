"use client";

import { Banner, Button, LayerDialog, Select } from "@cloudflare/kumo";
import { ArrowRightIcon, PlusIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { DateField } from "@/components/ui/date-field";
import { MonthPicker, shiftMonth, thisMonth, type Month } from "@/components/ui/month-picker";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill, type Tone } from "@/components/ui/pill";
import { SkeletonLine } from "@/components/ui/skeleton";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { dayOnly } from "@/lib/format";

interface Period {
  id: string;
  legalEntityId: string | null;
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

interface ChecklistItem {
  code: string;
  count: number;
}

interface LegalEntity {
  id: string;
  code: string;
  name: string;
}

type StepKey = "run" | "check" | "lock" | "pay";

const TONE: Record<Period["state"], Tone> = { OPEN: "waiting", LOCKED: "idle", PAID: "good" };

const STATE_KEY: Record<Period["state"], "stateOPEN" | "stateLOCKED" | "statePAID"> = {
  OPEN: "stateOPEN",
  LOCKED: "stateLOCKED",
  PAID: "statePAID",
};

const STEP_KEY: Record<StepKey, { name: "stepRun" | "stepCheck" | "stepLock" | "stepPay"; go: "goRun" | "goCheck" | "goLock" | "goPay" }> = {
  run: { name: "stepRun", go: "goRun" },
  check: { name: "stepCheck", go: "goCheck" },
  lock: { name: "stepLock", go: "goLock" },
  pay: { name: "stepPay", go: "goPay" },
};

// Company-wide is its own choice in the picker; the api reads a missing id as that.
const kWholeCompany = "";

function periodName(period: { year: number; month: number }): string {
  return `${String(period.month).padStart(2, "0")}/${period.year}`;
}

function order(at: { year: number; month: number }): number {
  return at.year * 12 + at.month;
}

/** This month, or the month after the newest period when this one is already open. */
function nextToOpen(periods: Period[], entityId: string): Month {
  const own = periods.filter((one) => (one.legalEntityId ?? kWholeCompany) === entityId);
  const now = thisMonth();
  if (!own.some((one) => one.year === now.year && one.month === now.month)) {
    return now;
  }
  const newest = own.reduce((best, one) => (order(one) > order(best) ? one : best), own[0]);
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
  const [entityId, setEntityId] = useState(kWholeCompany);
  const [payDate, setPayDate] = useState("");
  const [fault, setFault] = useState<string | null>(null);

  const periods = useQuery({
    queryKey: ["payroll-periods"],
    queryFn: async () => (await api.get<Period[]>("/payroll-periods")).data,
  });

  // The catalogue may not answer yet; one entity, or none, needs no picker.
  const entities = useQuery({
    queryKey: ["legal-entities"],
    retry: false,
    queryFn: async () => (await api.get<LegalEntity[]>("/legal-entities")).data,
  });
  const entityList = entities.data ?? [];
  const manyEntities = entityList.length > 1;
  const entityName = (id: string | null) =>
    id === null ? t("wholeCompany") : (entityList.find((one) => one.id === id)?.name ?? common("empty"));

  const current =
    periods.data?.find((one) => one.state === "OPEN") ?? periods.data?.find((one) => one.state === "LOCKED");
  const currentOpen = current?.state === "OPEN";

  const currentRuns = useQuery({
    queryKey: ["payroll-periods", current?.id, "runs"],
    enabled: currentOpen,
    queryFn: async () => (await api.get<Run[]>(`/payroll-periods/${current?.id}/runs`)).data,
  });
  const currentChecklist = useQuery({
    queryKey: ["payroll-periods", current?.id, "checklist"],
    enabled: currentOpen,
    queryFn: async () => (await api.get<ChecklistItem[]>(`/payroll-periods/${current?.id}/checklist`)).data,
  });

  const open = useMutation({
    mutationFn: async () =>
      (
        await api.post<Period>("/payroll-periods", {
          year: month.year,
          month: month.month,
          payDate: payDate || undefined,
          legalEntityId: entityId === kWholeCompany ? undefined : entityId,
        })
      ).data,
    onSuccess: (made) => {
      setOpening(false);
      notify.done(t("periodOpened", { period: periodName(made) }));
      void cache.invalidateQueries({ queryKey: ["payroll-periods"] });
      router.push(`/payroll/${made.id}`);
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function startOpening(): void {
    const first = manyEntities ? entityList[0].id : kWholeCompany;
    setFault(null);
    setPayDate("");
    setEntityId(first);
    setMonth(nextToOpen(periods.data ?? [], first));
    setOpening(true);
  }

  function stepOf(): StepKey | undefined {
    if (!current) {
      return undefined;
    }
    if (!currentOpen) {
      return "pay";
    }
    if (!(currentRuns.data ?? []).some((run) => run.kind === "REGULAR" && run.state === "DONE")) {
      return "run";
    }
    return (currentChecklist.data ?? []).some((item) => item.count > 0) ? "check" : "lock";
  }
  const step = stepOf();
  const stepKnown = !currentOpen || (currentRuns.isSuccess && currentChecklist.isSuccess);

  const columns: Column<Period>[] = [
    {
      id: "period",
      header: t("period"),
      cell: (row) => <span className="font-medium tabular-nums">{periodName(row)}</span>,
    },
    ...(manyEntities
      ? [
          {
            id: "entity",
            header: t("entity"),
            priority: 2 as const,
            truncate: true,
            cell: (row: Period) => entityName(row.legalEntityId),
          },
        ]
      : []),
    {
      id: "state",
      header: t("state"),
      cell: (row) => <StatePill tone={TONE[row.state]}>{t(STATE_KEY[row.state])}</StatePill>,
    },
    {
      id: "lockedAt",
      header: t("lockedAt"),
      priority: 3,
      cell: (row) => (row.lockedAt ? format.dateTime(new Date(row.lockedAt), "day") : common("empty")),
    },
    {
      id: "payDate",
      header: t("payDate"),
      priority: 2,
      cell: (row) => (row.payDate ? format.dateTime(dayOnly(row.payDate), "day") : common("empty")),
    },
  ];

  const entityItems: Record<string, string> = {
    [kWholeCompany]: t("wholeCompany"),
    ...Object.fromEntries(entityList.map((one) => [one.id, one.name])),
  };

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
          <AsideCard title={currentOpen || !current ? t("openNow") : t("inProgress")}>
            {periods.isPending ? (
              <SkeletonLine minWidth={25} maxWidth={40} />
            ) : current ? (
              <div className="flex flex-col gap-3">
                <Facts
                  rows={[
                    [t("period"), <span key="p" className="font-medium tabular-nums">{periodName(current)}</span>],
                    ...(manyEntities ? ([[t("entity"), entityName(current.legalEntityId)]] as [string, string][]) : []),
                    [t("stepNow"), stepKnown && step ? t(STEP_KEY[step].name) : common("empty")],
                  ]}
                />
                <Button
                  variant="secondary"
                  icon={ArrowRightIcon}
                  className="self-start"
                  onClick={() => router.push(`/payroll/${current.id}`)}
                >
                  {stepKnown && step ? t(STEP_KEY[step].go) : t("openThePeriod", { period: periodName(current) })}
                </Button>
              </div>
            ) : (
              <p className="text-kumo-subtle">{t("openNone")}</p>
            )}
          </AsideCard>
        }
      >
        <DataTable
          id="payroll-periods"
          cardLead="period"
          cardTrailing="state"
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
              {manyEntities ? (
                <Select
                  label={t("entity")}
                  hideLabel={false}
                  value={entityId}
                  onValueChange={(next) => {
                    const chosen = String(next ?? kWholeCompany);
                    setEntityId(chosen);
                    setMonth(nextToOpen(periods.data ?? [], chosen));
                  }}
                  items={entityItems}
                  className="w-full"
                />
              ) : null}
              <div className="flex flex-col gap-1.5">
                <span className="font-medium">{t("month")}</span>
                <MonthPicker value={month} onChange={setMonth} />
              </div>
              <DateField
                label={t("payDate")}
                value={payDate}
                description={t("payDateHint")}
                required={false}
                onChange={setPayDate}
              />
              {fault ? <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null}
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
