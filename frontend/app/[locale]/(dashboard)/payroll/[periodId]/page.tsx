"use client";

import { Button, Checkbox, Empty, Input, LayerCard, LayerDialog, Radio, SkeletonLine } from "@cloudflare/kumo";
import {
  CaretLeftIcon,
  CheckCircleIcon,
  CheckIcon,
  DownloadSimpleIcon,
  PaperPlaneTiltIcon,
  PlayIcon,
  PlusIcon,
  ReceiptIcon,
  WalletIcon,
  LockSimpleIcon,
  CalculatorIcon,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useState, type ReactNode } from "react";

import { BonusSheet } from "@/components/payroll/bonus-sheet";
import { PayslipView, type Payslip } from "@/components/payroll/payslip-view";
import { RunProgress, type PayrollRun, type RunKind } from "@/components/payroll/run-progress";
import { SettlementSheet } from "@/components/payroll/settlement-sheet";
import { DataTable, type Column } from "@/components/tables/data-table";
import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, PageHeader, PageLayout } from "@/components/ui/page";
import { CountPill, StatePill, type Tone } from "@/components/ui/pill";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { useFault } from "@/lib/fault";
import { days, money } from "@/lib/format";
import { allows } from "@/lib/nav";

interface ChecklistItem {
  code: string;
  count: number;
}

interface Period {
  id: string;
  year: number;
  month: number;
  state: "OPEN" | "LOCKED" | "PAID";
  lockNote: string | null;
}

interface SlipRow {
  id: string;
  employeeId: number;
  state: Payslip["state"];
  workedDays: string;
  grossPay: string;
  netPay: string;
  sentAt: string | null;
  employee?: { code: string; fullName: string };
}

interface SlipPage {
  rows: SlipRow[];
  total: number;
  totalIsExact?: boolean;
  next?: string | null;
}

type ItemKey =
  | "REQUESTS_PENDING"
  | "CORRECTIONS_OPEN"
  | "NO_COMPENSATION"
  | "NO_ATTENDANCE_DAYS"
  | "LEAVERS_HOLDING_ASSETS"
  | "DISPUTES_OVERDUE"
  | "NO_LEGAL_ENTITY";

// Where each open item is settled; an item without a row here is only counted.
const HANDLED_AT: Record<string, string> = {
  REQUESTS_PENDING: "/approvals",
  DISPUTES_OVERDUE: "/approvals",
  CORRECTIONS_OPEN: "/timesheet",
  NO_ATTENDANCE_DAYS: "/timesheet",
  NO_COMPENSATION: "/employees",
  NO_LEGAL_ENTITY: "/employees",
  LEAVERS_HOLDING_ASSETS: "/assets",
};

const PERIOD_TONE: Record<Period["state"], Tone> = { OPEN: "waiting", LOCKED: "idle", PAID: "good" };

const PERIOD_KEY: Record<Period["state"], "stateOPEN" | "stateLOCKED" | "statePAID"> = {
  OPEN: "stateOPEN",
  LOCKED: "stateLOCKED",
  PAID: "statePAID",
};

const SLIP_TONE: Record<Payslip["state"], Tone> = { DRAFT: "idle", ISSUED: "waiting", SENT: "good", VIEWED: "good" };

const KINDS: RunKind[] = ["REGULAR", "BONUS", "FINAL_SETTLEMENT"];

const KIND_HINT: Record<RunKind, "runREGULARHint" | "runBONUSHint" | "runFINAL_SETTLEMENTHint"> = {
  REGULAR: "runREGULARHint",
  BONUS: "runBONUSHint",
  FINAL_SETTLEMENT: "runFINAL_SETTLEMENTHint",
};

const kRunPollMs = 2_000;
const kSlipPage = 50;

type StepKey = "run" | "check" | "lock" | "pay" | "deliver";
type StepState = "done" | "current" | "later";

const STEP_NAME: Record<StepKey, "stepRun" | "stepCheck" | "stepLock" | "stepPay" | "stepDeliver"> = {
  run: "stepRun",
  check: "stepCheck",
  lock: "stepLock",
  pay: "stepPay",
  deliver: "stepDeliver",
};

interface Step {
  key: StepKey;
  state: StepState;
  body?: ReactNode;
}

function periodName(period: { year: number; month: number }): string {
  return `${String(period.month).padStart(2, "0")}/${period.year}`;
}

function save(text: string, name: string): void {
  const link = document.createElement("a");
  // The api already opens the file with a BOM, so this must not add one.
  link.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

/** The five steps of a period, which of them are done, and the action of the one that is next. */
function Stepper({ steps }: { steps: Step[] }) {
  const t = useTranslations("payroll");
  return (
    <ol className="flex flex-col">
      {steps.map((step, at) => (
        <li key={step.key} className="relative flex gap-3 pb-5 last:pb-0">
          {at < steps.length - 1 ? (
            <span aria-hidden className="absolute start-3 top-7 bottom-1 w-px bg-kumo-hairline" />
          ) : null}
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-full text-sm font-medium tabular-nums",
              step.state === "done" && "bg-kumo-tint text-kumo-success",
              step.state === "current" && "bg-kumo-contrast text-kumo-inverse",
              step.state === "later" && "bg-kumo-tint text-kumo-subtle",
            )}
          >
            {step.state === "done" ? <CheckIcon size={14} weight="bold" aria-hidden /> : at + 1}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex min-h-6 flex-wrap items-center gap-2">
              <span className={cn("font-medium", step.state === "later" && "text-kumo-subtle")}>{t(STEP_NAME[step.key])}</span>
              {step.state === "done" ? <StatePill tone="good">{t("stepDone")}</StatePill> : null}
              {step.state === "current" ? <StatePill tone="waiting">{t("stepNext")}</StatePill> : null}
            </div>
            {step.body}
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function PayrollPeriodPage() {
  const t = useTranslations("payroll");
  const common = useTranslations("common");
  const locale = useLocale();
  const format = useFormatter();
  const params = useParams<{ periodId: string }>();
  const periodId = params.periodId;
  const { role, employeeId } = useSession();
  const mayWrite = role === "ADMIN" || role === "PAYROLL";
  const cache = useQueryClient();
  const notify = useNotify();
  const faultOf = useFault();

  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<RunKind>("REGULAR");
  const [label, setLabel] = useState("");
  const [locking, setLocking] = useState(false);
  const [accept, setAccept] = useState(false);
  const [paying, setPaying] = useState(false);
  const [sending, setSending] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [slipsOf, setSlipsOf] = useState<PayrollRun | null>(null);
  const [slipOpen, setSlipOpen] = useState<SlipRow | null>(null);

  const periods = useQuery({
    queryKey: ["payroll-periods"],
    queryFn: async () => (await api.get<Period[]>("/payroll-periods")).data,
  });
  const period = periods.data?.find((one) => one.id === periodId);
  const name = period ? periodName(period) : "";

  const checklist = useQuery({
    queryKey: ["payroll-periods", periodId, "checklist"],
    queryFn: async () => (await api.get<ChecklistItem[]>(`/payroll-periods/${periodId}/checklist`)).data,
  });

  const runs = useQuery({
    queryKey: ["payroll-periods", periodId, "runs"],
    refetchInterval: (query) => ((query.state.data ?? []).some((run) => run.state === "RUNNING") ? kRunPollMs : false),
    queryFn: async () => (await api.get<PayrollRun[]>(`/payroll-periods/${periodId}/runs`)).data,
  });

  const delivery = useQuery({
    queryKey: ["payroll-periods", periodId, "delivery"],
    enabled: period !== undefined && period.state !== "OPEN",
    queryFn: async () => (await api.get<{ issued: number; sent: number }>(`/payroll-periods/${periodId}/delivery`)).data,
  });

  const slips = useInfiniteQuery({
    queryKey: ["payslips", "run", slipsOf?.id],
    enabled: slipsOf !== null,
    initialPageParam: "",
    queryFn: async ({ pageParam }) =>
      (
        await api.get<SlipPage>(
          `/payslips?runId=${slipsOf?.id}&take=${kSlipPage}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        )
      ).data,
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const slip = useQuery({
    queryKey: ["payslips", slipOpen?.id],
    enabled: slipOpen !== null,
    queryFn: async () => (await api.get<Payslip>(`/payslips/${slipOpen?.id}`)).data,
  });

  function refresh(): void {
    void cache.invalidateQueries({ queryKey: ["payroll-periods"] });
    void cache.invalidateQueries({ queryKey: ["payslips"] });
  }

  const runName = (run: PayrollRun): string => run.label ?? t(`run${run.kind}`);

  const create = useMutation({
    mutationFn: async () =>
      (await api.post<PayrollRun>("/payroll-runs", { periodId, kind, label: label.trim() || undefined })).data,
    onSuccess: (made) => {
      setCreating(false);
      notify.done(t("runCreated", { name: runName(made) }));
      refresh();
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const execute = useMutation({
    mutationFn: async (run: PayrollRun) => (await api.post<PayrollRun>(`/payroll-runs/${run.id}/execute`)).data,
    onSuccess: (_, run) => {
      notify.done(t("runStarted", { name: runName(run) }));
      refresh();
    },
    onError: notify.failed,
  });

  const lock = useMutation({
    mutationFn: () => api.post(`/payroll-periods/${periodId}/lock`, { acceptOpenItems: accept }),
    onSuccess: () => {
      setLocking(false);
      notify.done(t("lockDone", { period: name }));
      refresh();
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const pay = useMutation({
    mutationFn: () => api.post(`/payroll-periods/${periodId}/paid`),
    onSuccess: () => {
      setPaying(false);
      notify.done(t("paidDone", { period: name }));
      refresh();
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const exportFile = useMutation({
    mutationFn: async (kindOf: "bank" | "ledger") =>
      save((await api.get<string>(`/payroll-periods/${periodId}/export?kind=${kindOf}`)).data, `payroll-${kindOf}-${name.replace("/", "-")}.csv`),
    onSuccess: (_, kindOf) => notify.done(t(kindOf === "bank" ? "exportBankDone" : "exportLedgerDone")),
    onError: notify.failed,
  });

  const deliver = useMutation({
    mutationFn: async () => (await api.post<{ queued: number }>(`/payroll-periods/${periodId}/deliver`)).data,
    onSuccess: (done) => {
      setSending(false);
      notify.done(t("delivered", { count: done.queued }));
      refresh();
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  if (periods.isError) {
    return (
      <>
        <PageHeader title={t("period")} />
        <Failed onRetry={() => void periods.refetch()} />
      </>
    );
  }
  if (periods.isSuccess && !period) {
    return (
      <>
        <PageHeader title={t("period")} />
        <LayerCard className="p-0">
          <Empty title={t("periodMissing")} description={t("periodMissingHint")} className="py-12" />
        </LayerCard>
      </>
    );
  }

  const open = period?.state === "OPEN";
  const runList = runs.data ?? [];
  const openItems = (checklist.data ?? []).filter((item) => item.count > 0);
  const regularDone = runList.some((run) => run.kind === "REGULAR" && run.state === "DONE");
  const delivered =
    deliver.isSuccess || (delivery.data !== undefined && delivery.data.issued > 0 && delivery.data.sent === delivery.data.issued);

  function begin(openDialog: (next: boolean) => void): void {
    setFault(null);
    openDialog(true);
  }

  function startCreating(): void {
    setKind(regularDone ? "BONUS" : "REGULAR");
    setLabel("");
    begin(setCreating);
  }

  const doneOf: Record<StepKey, boolean> = {
    run: !open || regularDone,
    check: !open || (regularDone && checklist.isSuccess && openItems.length === 0),
    lock: period !== undefined && !open,
    pay: period?.state === "PAID",
    deliver: delivered,
  };
  const order: StepKey[] = ["run", "check", "lock", "pay", "deliver"];
  const current = period ? order.find((key) => !doneOf[key]) : undefined;
  const lockButton = mayWrite ? (
    <Button
      variant="secondary"
      icon={LockSimpleIcon}
      className="self-start"
      onClick={() => {
        setAccept(false);
        begin(setLocking);
      }}
    >
      {t("lockAction")}
    </Button>
  ) : null;

  const bodyOf: Record<StepKey, ReactNode> = {
    run:
      current === "run" ? (
        <p className="text-sm text-kumo-subtle">{runList.some((run) => run.kind === "REGULAR") ? t("stepRunEach") : t("stepRunNone")}</p>
      ) : null,
    check:
      current === "check" ? (
        <>
          <p className="text-sm text-kumo-subtle">{t("stepCheckOpen", { count: openItems.length })}</p>
          {lockButton}
        </>
      ) : null,
    lock: current === "lock" ? lockButton : null,
    pay:
      period && !open ? (
        <div className="flex flex-col gap-2">
          {mayWrite ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                icon={DownloadSimpleIcon}
                loading={exportFile.isPending && exportFile.variables === "bank"}
                onClick={() => exportFile.mutate("bank")}
              >
                {t("exportBank")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={DownloadSimpleIcon}
                loading={exportFile.isPending && exportFile.variables === "ledger"}
                onClick={() => exportFile.mutate("ledger")}
              >
                {t("exportLedger")}
              </Button>
            </div>
          ) : null}
          {current === "pay" && mayWrite ? (
            <Button variant="secondary" icon={WalletIcon} className="self-start" onClick={() => begin(setPaying)}>
              {t("markPaid")}
            </Button>
          ) : null}
        </div>
      ) : null,
    deliver:
      current === "deliver" && mayWrite ? (
        <Button variant="secondary" icon={PaperPlaneTiltIcon} className="self-start" onClick={() => begin(setSending)}>
          {t("deliver")}
        </Button>
      ) : null,
  };
  const steps: Step[] = order.map((key) => ({
    key,
    state: doneOf[key] ? "done" : key === current ? "current" : "later",
    body: bodyOf[key],
  }));

  const slipRows = slips.data?.pages.flatMap((page) => page.rows);
  const firstPage = slips.data?.pages[0];
  const slipColumns: Column<SlipRow>[] = [
    {
      id: "employee",
      header: t("slipEmployee"),
      sticky: true,
      sortBy: (row) => row.employee?.fullName ?? row.employeeId,
      cell: (row) =>
        row.employee ? (
          <span className="flex items-baseline gap-2">
            <span>{row.employee.fullName}</span>
            <span className="font-mono text-sm text-kumo-subtle">{row.employee.code}</span>
          </span>
        ) : (
          <span className="font-mono">#{row.employeeId}</span>
        ),
    },
    {
      id: "workedDays",
      header: t("workedDays"),
      numeric: true,
      sortBy: (row) => Number(row.workedDays),
      cell: (row) => days(Number(row.workedDays), locale),
    },
    {
      id: "net",
      header: t("net"),
      numeric: true,
      sortBy: (row) => Number(row.netPay),
      cell: (row) => money(Number(row.netPay), locale),
    },
    {
      id: "state",
      header: t("state"),
      sortBy: (row) => row.state,
      cell: (row) => <StatePill tone={SLIP_TONE[row.state]}>{t(`state${row.state}`)}</StatePill>,
    },
  ];

  return (
    <>
      <PageHeader
        title={period ? t("periodTitle", { period: name }) : t("period")}
        meta={period ? <StatePill tone={PERIOD_TONE[period.state]}>{t(PERIOD_KEY[period.state])}</StatePill> : undefined}
        description={period ? t(open ? "periodLeadOpen" : period.state === "LOCKED" ? "periodLeadLocked" : delivered ? "periodLeadDone" : "periodLeadPaid") : undefined}
        actions={
          mayWrite && open ? (
            <Button variant="primary" icon={PlusIcon} onClick={startCreating}>
              {t("newRun")}
            </Button>
          ) : undefined
        }
      />

      <PageLayout
        aside={
          <AsideCard title={t("stepsTitle")}>
            {periods.isPending || runs.isPending ? (
              <div className="flex flex-col gap-3">
                {order.map((key) => (
                  <SkeletonLine key={key} minWidth={25} maxWidth={37} />
                ))}
              </div>
            ) : (
              <Stepper steps={steps} />
            )}
          </AsideCard>
        }
      >
        <div className="flex flex-col gap-8">
          <section className="flex flex-col gap-3">
            <h2 className="m-0 flex items-center gap-2 text-lg font-semibold">
              {t("runs")}
              {runList.length > 0 ? <CountPill>{runList.length}</CountPill> : null}
            </h2>
            {runs.isError ? (
              <Failed onRetry={() => void runs.refetch()} />
            ) : runs.isPending ? (
              <LayerCard className="flex flex-col gap-3 p-4">
                <SkeletonLine minWidth={25} maxWidth={43} />
                <SkeletonLine minWidth={33} maxWidth={70} />
              </LayerCard>
            ) : runList.length === 0 ? (
              <LayerCard className="p-0">
                <Empty
                  icon={<CalculatorIcon size={40} className="text-kumo-inactive" />}
                  title={t("runsEmpty")}
                  description={open ? t("runsEmptyHint") : undefined}
                  contents={
                    mayWrite && open ? (
                      <Button variant="primary" icon={PlusIcon} onClick={startCreating}>
                        {t("newRun")}
                      </Button>
                    ) : undefined
                  }
                  className="py-12"
                />
              </LayerCard>
            ) : (
              runList.map((run) => {
                const editable = mayWrite && open && run.state !== "RUNNING";
                return (
                  <RunProgress
                    key={run.id}
                    run={run}
                    action={
                      <span className="flex flex-wrap gap-2">
                        {run.doneCount > 0 ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={ReceiptIcon}
                            onClick={() => {
                              setSlipOpen(null);
                              setSlipsOf(run);
                            }}
                          >
                            {t("payslips")}
                          </Button>
                        ) : null}
                        {mayWrite && open ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={PlayIcon}
                            loading={(execute.isPending && execute.variables?.id === run.id) || run.state === "RUNNING"}
                            onClick={() => execute.mutate(run)}
                          >
                            {run.state === "DONE" || run.state === "FAILED" ? t("rerun") : t("run")}
                          </Button>
                        ) : null}
                      </span>
                    }
                  >
                    {mayWrite && run.kind === "BONUS" ? <BonusSheet runId={run.id} editable={editable} /> : null}
                    {mayWrite && run.kind === "FINAL_SETTLEMENT" ? <SettlementSheet runId={run.id} editable={editable} /> : null}
                  </RunProgress>
                );
              })
            )}
          </section>

          {open ? (
            <section className="flex flex-col gap-3">
              <h2 className="m-0 text-lg font-semibold">{t("checkTitle")}</h2>
              {checklist.isError ? (
                <Failed onRetry={() => void checklist.refetch()} />
              ) : (
                <LayerCard>
                  <LayerCard.Secondary className="justify-between">
                    <span>{t("checklist")}</span>
                    {checklist.isSuccess ? (
                      openItems.length === 0 ? (
                        <StatePill tone="good">{t("checklistClear")}</StatePill>
                      ) : (
                        <StatePill tone="waiting">{t("checklistOpen", { count: openItems.length })}</StatePill>
                      )
                    ) : null}
                  </LayerCard.Secondary>
                  <LayerCard.Primary>
                    {checklist.isPending ? (
                      <SkeletonLine minWidth={25} maxWidth={43} />
                    ) : openItems.length === 0 ? (
                      <p className="flex items-center gap-2 text-kumo-subtle">
                        <CheckCircleIcon size={18} className="text-kumo-success" aria-hidden />
                        {t("checklistClearHint")}
                      </p>
                    ) : (
                      <ul className="-mx-2 -my-1 flex flex-col">
                        {openItems.map((item) => {
                          const where = HANDLED_AT[item.code];
                          const body = (
                            <>
                              <span className="min-w-0 truncate">{t(item.code as ItemKey)}</span>
                              <span className="shrink-0 font-medium text-kumo-warning tabular-nums">{format.number(item.count)}</span>
                            </>
                          );
                          const row = "flex min-h-9 items-center justify-between gap-3 rounded-md px-2";
                          return (
                            <li key={item.code}>
                              {where && allows(role, employeeId !== null, where) ? (
                                <Link href={where} className={cn(row, "hover:bg-kumo-tint")}>
                                  {body}
                                </Link>
                              ) : (
                                <div className={row}>{body}</div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </LayerCard.Primary>
                </LayerCard>
              )}
            </section>
          ) : null}
        </div>
      </PageLayout>

      <LayerDialog.Root open={creating} onOpenChange={setCreating} dismissDisabled={create.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("newRun")}</LayerDialog.Title>
          <LayerDialog.Description>{t("newRunLead", { period: name })}</LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              <Radio.Group
                legend={t("runKind")}
                appearance="card"
                value={kind}
                onValueChange={(next) => setKind(next as RunKind)}
              >
                {KINDS.map((one) => (
                  <Radio.Item key={one} value={one} label={t(`run${one}`)} description={t(KIND_HINT[one])} />
                ))}
              </Radio.Group>
              <Input
                label={t("runLabel")}
                description={t("runLabelHint")}
                maxLength={120}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
              {fault ? <p className="text-kumo-danger">{fault}</p> : null}
            </div>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary loading={create.isPending} onClick={() => create.mutate()}>
              {t("createRun")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Alert open={locking} onOpenChange={setLocking} dismissDisabled={lock.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("lockTitle", { period: name })}</LayerDialog.Title>
          <LayerDialog.Description>{t("lockWarn", { period: name })}</LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-3">
              {openItems.length > 0 ? (
                <>
                  <p className="text-kumo-warning">{t("lockOpenItems", { count: openItems.length })}</p>
                  <ul className="flex flex-col">
                    {openItems.map((item) => (
                      <li key={item.code} className="flex justify-between gap-3 border-b border-kumo-hairline py-1.5 last:border-0">
                        <span>{t(item.code as ItemKey)}</span>
                        <span className="tabular-nums">{format.number(item.count)}</span>
                      </li>
                    ))}
                  </ul>
                  <Checkbox label={t("acceptOpen")} checked={accept} onCheckedChange={(next) => setAccept(next === true)} />
                </>
              ) : (
                <p className="text-kumo-subtle">{t("checklistClearHint")}</p>
              )}
              {fault ? <p className="text-kumo-danger">{fault}</p> : null}
            </div>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              variant="destructive"
              loading={lock.isPending}
              disabled={openItems.length > 0 && !accept}
              onClick={() => lock.mutate()}
            >
              {t("lockGo", { period: name })}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>

      <LayerDialog.Alert open={paying} onOpenChange={setPaying} dismissDisabled={pay.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("payTitle", { period: name })}</LayerDialog.Title>
          <LayerDialog.Description>{t("payWarn", { period: name })}</LayerDialog.Description>
          <LayerDialog.Body>
            <p className="text-kumo-subtle">{t("payNote")}</p>
            {fault ? <p className="mt-3 text-kumo-danger">{fault}</p> : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary variant="destructive" loading={pay.isPending} onClick={() => pay.mutate()}>
              {t("markPaid")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>

      <LayerDialog.Alert open={sending} onOpenChange={setSending} dismissDisabled={deliver.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("deliverTitle", { period: name })}</LayerDialog.Title>
          <LayerDialog.Description>{t("deliverWarn")}</LayerDialog.Description>
          <LayerDialog.Body>
            <p className="text-kumo-subtle">{t("deliverNote")}</p>
            {fault ? <p className="mt-3 text-kumo-danger">{fault}</p> : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary variant="destructive" loading={deliver.isPending} onClick={() => deliver.mutate()}>
              {t("deliverGo")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>

      <LayerDialog.Root
        open={slipsOf !== null}
        onOpenChange={(next) => {
          if (!next) {
            setSlipsOf(null);
            setSlipOpen(null);
          }
        }}
      >
        <LayerDialog.Content size="xl" closeLabel={common("close")}>
          <LayerDialog.Title>
            {slipOpen
              ? t("slipOf", { name: slipOpen.employee?.fullName ?? `#${slipOpen.employeeId}` })
              : t("slipsOf", { name: slipsOf ? runName(slipsOf) : "" })}
          </LayerDialog.Title>
          <LayerDialog.Description>
            {firstPage ? t("slipsLead", { period: name, count: firstPage.total }) : t("periodTitle", { period: name })}
          </LayerDialog.Description>
          <LayerDialog.Body>
            {slipOpen ? (
              <div className="flex flex-col gap-4">
                <Button variant="ghost" size="sm" icon={CaretLeftIcon} className="self-start" onClick={() => setSlipOpen(null)}>
                  {t("slipsBack")}
                </Button>
                {slip.isError ? (
                  <Failed onRetry={() => void slip.refetch()} />
                ) : slip.data ? (
                  <PayslipView slip={slip.data} />
                ) : (
                  <div className="flex flex-col gap-3">
                    <SkeletonLine minWidth={27} maxWidth={53} />
                    <SkeletonLine minWidth={33} maxWidth={80} />
                  </div>
                )}
              </div>
            ) : (
              <DataTable
                id="run-payslips"
                cardLead="employee"
                columns={slipColumns}
                rows={slipRows}
                keyOf={(row) => row.id}
                pending={slips.isPending}
                failed={slips.isError}
                onRetry={() => void slips.refetch()}
                onRowClick={setSlipOpen}
                empty={t("empty")}
                paging={
                  firstPage
                    ? {
                        shown: slipRows?.length ?? 0,
                        total: firstPage.total,
                        exact: firstPage.totalIsExact,
                        onMore: slips.hasNextPage ? () => void slips.fetchNextPage() : undefined,
                        loading: slips.isFetchingNextPage,
                      }
                    : undefined
                }
              />
            )}
          </LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}
