"use client";

import { Banner, Button, Checkbox, Empty, Input, LayerCard, LayerDialog, Radio } from "@cloudflare/kumo";
import {
  CalculatorIcon,
  CheckCircleIcon,
  CheckIcon,
  DownloadSimpleIcon,
  LockSimpleIcon,
  PaperPlaneTiltIcon,
  PlayIcon,
  PlusIcon,
  ReceiptIcon,
  WalletIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";

import { BonusSheet } from "@/components/payroll/bonus-sheet";
import { PayslipView, type Payslip } from "@/components/payroll/payslip-view";
import { RunProgress, type PayrollRun, type RunKind } from "@/components/payroll/run-progress";
import { SettlementSheet } from "@/components/payroll/settlement-sheet";
import { DataTable, PersonCell, type Column } from "@/components/tables/data-table";
import { Failed } from "@/components/ui/failed";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { useNotify } from "@/components/ui/notify";
import { useOptional } from "@/components/ui/optional";
import { AsideCard, Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { CountPill, StatePill, type Tone } from "@/components/ui/pill";
import { SkeletonLine } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { useFault } from "@/lib/fault";
import { money } from "@/lib/format";
import { allows } from "@/lib/nav";
import { useUrlState } from "@/lib/url-state";

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

interface Totals {
  payslips: number;
  people: number;
  gross: string;
  net: string;
  insuranceEmployer: string;
  employerCost: string;
}

interface SlipRow {
  id: string;
  employeeId: number;
  state: Payslip["state"];
  grossPay: string;
  insuranceEmployee: string;
  personalIncomeTax: string;
  advance: string;
  netPay: string;
  employee: { code: string; fullName: string; department: { id: string; name: string } | null };
  run: { kind: RunKind; state: PayrollRun["state"] };
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
const kLabelMax = 120;

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
  // The api already opens the file with a BOM where Excel needs one, so this must not add one.
  link.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

function FaultBanner({ fault }: { fault: string | null }) {
  return fault ? <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null;
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

function PayrollPeriod() {
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
  const optional = useOptional();

  const [url, setUrl] = useUrlState({ q: "", run: "" });
  const [typed, setTyped] = useState(url.q);
  const settled = useSettled(typed.trim());
  useEffect(() => {
    if (settled !== url.q) {
      setUrl({ q: settled });
    }
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps

  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<RunKind>("REGULAR");
  const [label, setLabel] = useState("");
  const [locking, setLocking] = useState(false);
  const [accept, setAccept] = useState(false);
  const [paying, setPaying] = useState(false);
  const [sending, setSending] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [slipOpen, setSlipOpen] = useState<SlipRow | null>(null);
  const table = useRef<HTMLElement | null>(null);

  const periods = useQuery({
    queryKey: ["payroll-periods"],
    queryFn: async () => (await api.get<Period[]>("/payroll-periods")).data,
  });
  const period = periods.data?.find((one) => one.id === periodId);
  const name = period ? periodName(period) : "";
  const open = period?.state === "OPEN";

  const checklist = useQuery({
    queryKey: ["payroll-periods", periodId, "checklist"],
    queryFn: async () => (await api.get<ChecklistItem[]>(`/payroll-periods/${periodId}/checklist`)).data,
  });

  const runs = useQuery({
    queryKey: ["payroll-periods", periodId, "runs"],
    refetchInterval: (query) => ((query.state.data ?? []).some((run) => run.state === "RUNNING") ? kRunPollMs : false),
    queryFn: async () => (await api.get<PayrollRun[]>(`/payroll-periods/${periodId}/runs`)).data,
  });
  const runList = runs.data ?? [];

  // A run leaving RUNNING changes the payslips and the steps, which the poll alone never re-reads.
  const running = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(runList.filter((run) => run.state === "RUNNING").map((run) => run.id));
    const ended = [...running.current].some((id) => !now.has(id));
    running.current = now;
    if (ended) {
      void cache.invalidateQueries({ queryKey: ["payroll-periods"] });
      void cache.invalidateQueries({ queryKey: ["payslips"] });
    }
  }, [runList, cache]);

  const delivery = useQuery({
    queryKey: ["payroll-periods", periodId, "delivery"],
    enabled: period !== undefined && !open,
    queryFn: async () => (await api.get<{ issued: number; sent: number }>(`/payroll-periods/${periodId}/delivery`)).data,
  });

  const totals = useQuery({
    queryKey: ["payroll-periods", periodId, "totals"],
    queryFn: async () => (await api.get<Totals>(`/payroll-periods/${periodId}/totals`)).data,
  });

  // An open period reads one run's drafts, the newest finished regular one unless the reader picks another.
  const newestRegular = runList.find((run) => run.kind === "REGULAR" && run.state === "DONE");
  const shownRun = open ? (runList.find((run) => run.id === url.run) ?? newestRegular) : undefined;
  const slipFilter = new URLSearchParams({ periodId });
  if (open && shownRun) {
    slipFilter.set("runId", shownRun.id);
  }
  if (!open) {
    slipFilter.set("issued", "true");
  }
  if (url.q) {
    slipFilter.set("search", url.q);
  }
  const slipsReady = period !== undefined && (!open || shownRun !== undefined);

  const slips = useInfiniteQuery({
    queryKey: ["payslips", "period", slipFilter.toString()],
    enabled: slipsReady,
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const page = new URLSearchParams(slipFilter);
      page.set("take", String(kSlipPage));
      if (pageParam) {
        page.set("cursor", pageParam);
      }
      return (await api.get<SlipPage>(`/payslips?${page.toString()}`)).data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const slip = useQuery({
    queryKey: ["payslips", slipOpen?.id],
    enabled: slipOpen !== null,
    queryFn: async () => (await api.get<Payslip>(`/payslips/${slipOpen?.id}`)).data,
  });

  function refresh(): void {
    void cache.invalidateQueries({ queryKey: ["payroll-periods"] });
    void cache.invalidateQueries({ queryKey: ["payroll-runs"] });
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
      save(
        (await api.get<string>(`/payroll-periods/${periodId}/export?kind=${kindOf}`)).data,
        `payroll-${kindOf}-${name.replace("/", "-")}.csv`,
      ),
    onSuccess: (_, kindOf) => notify.done(t(kindOf === "bank" ? "exportBankDone" : "exportLedgerDone")),
    onError: notify.failed,
  });

  const exportSlips = useMutation({
    mutationFn: async () =>
      save((await api.get<string>(`/payslips/export?${slipFilter.toString()}`)).data, `payslips-${name.replace("/", "-")}.csv`),
    onSuccess: () => notify.done(t("slipsExported")),
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

  const openItems = (checklist.data ?? []).filter((item) => item.count > 0);
  const regularDone = newestRegular !== undefined;
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

  function showSlipsOf(run: PayrollRun): void {
    setUrl({ run: run.id === newestRegular?.id ? "" : run.id });
    table.current?.scrollIntoView({ behavior: "smooth", block: "start" });
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
        <>
          <p className="text-sm text-kumo-subtle">{runList.some((run) => run.kind === "REGULAR") ? t("stepRunEach") : t("stepRunNone")}</p>
          {mayWrite && !runList.some((run) => run.kind === "REGULAR") ? (
            <Button variant="secondary" icon={PlusIcon} className="self-start" onClick={startCreating}>
              {t("newRun")}
            </Button>
          ) : null}
        </>
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
  const amount = (value: string) => money(Number(value), locale);
  const slipColumns: Column<SlipRow>[] = [
    {
      id: "employee",
      header: t("slipEmployee"),
      cell: (row) => <PersonCell name={row.employee.fullName} code={row.employee.code} />,
    },
    {
      id: "department",
      header: t("department"),
      priority: 3,
      truncate: true,
      maxWidthPx: 180,
      cell: (row) => row.employee.department?.name ?? common("empty"),
    },
    { id: "gross", header: t("gross"), numeric: true, priority: 2, cell: (row) => amount(row.grossPay) },
    { id: "insurance", header: t("insurance"), numeric: true, priority: 3, cell: (row) => amount(row.insuranceEmployee) },
    { id: "tax", header: t("tax"), numeric: true, priority: 3, cell: (row) => amount(row.personalIncomeTax) },
    {
      id: "advance",
      header: t("advanceShort"),
      numeric: true,
      priority: 3,
      cell: (row) => (Number(row.advance) > 0 ? amount(row.advance) : common("empty")),
    },
    { id: "net", header: t("net"), numeric: true, cell: (row) => <span className="font-medium">{amount(row.netPay)}</span> },
    {
      id: "state",
      header: t("state"),
      priority: 2,
      cell: (row) => (
        <span className="flex flex-wrap gap-1">
          <StatePill tone={SLIP_TONE[row.state]}>{t(`state${row.state}`)}</StatePill>
          {row.run.kind !== "REGULAR" ? <StatePill>{t(`run${row.run.kind}`)}</StatePill> : null}
        </span>
      ),
    },
  ];

  const runItems: Record<string, string> = Object.fromEntries(
    runList.filter((run) => run.doneCount > 0).map((run) => [run.id === newestRegular?.id ? "" : run.id, runName(run)]),
  );
  const sum = totals.data;

  return (
    <>
      <PageHeader
        title={period ? t("periodTitle", { period: name }) : t("period")}
        meta={period ? <StatePill tone={PERIOD_TONE[period.state]}>{t(PERIOD_KEY[period.state])}</StatePill> : undefined}
        description={
          period
            ? t(open ? "periodLeadOpen" : period.state === "LOCKED" ? "periodLeadLocked" : delivered ? "periodLeadDone" : "periodLeadPaid")
            : undefined
        }
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
          <>
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
            <AsideCard title={t("totalsTitle")}>
              {totals.isError ? (
                <Failed onRetry={() => void totals.refetch()} />
              ) : (
                <>
                  <Facts
                    rows={[
                      [t("totalsSlips"), sum ? sum.payslips : common("empty")],
                      [t("gross"), sum ? <span className="tabular-nums">{amount(sum.gross)}</span> : common("empty")],
                      [t("net"), sum ? <span className="tabular-nums">{amount(sum.net)}</span> : common("empty")],
                      [t("totalsEmployerCost"), sum ? <span className="tabular-nums">{amount(sum.employerCost)}</span> : common("empty")],
                    ]}
                  />
                  <p className="mt-3 text-sm text-kumo-subtle">{t(open ? "totalsOpenHint" : "totalsIssuedHint")}</p>
                </>
              )}
            </AsideCard>
          </>
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
                        {open && run.doneCount > 0 ? (
                          <Button variant="ghost" size="sm" icon={ReceiptIcon} onClick={() => showSlipsOf(run)}>
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

          <section ref={table} className="flex scroll-mt-24 flex-col gap-3">
            <h2 className="m-0 flex items-center gap-2 text-lg font-semibold">
              {open && shownRun ? t("slipsOf", { name: runName(shownRun) }) : t("payslips")}
              {firstPage ? <CountPill>{format.number(firstPage.total)}</CountPill> : null}
            </h2>
            {slipsReady ? (
              <>
                <FilterBar
                  search={{ value: typed, onChange: setTyped, placeholder: t("slipSearchHint") }}
                  filters={
                    open && Object.keys(runItems).length > 1
                      ? [
                          {
                            key: "run",
                            label: t("slipRun"),
                            value: shownRun?.id === newestRegular?.id ? "" : (shownRun?.id ?? ""),
                            onChange: (value) => setUrl({ run: value }),
                            items: runItems,
                          },
                        ]
                      : []
                  }
                  extra={
                    mayWrite || role === "HR" ? (
                      <Button
                        variant="secondary"
                        icon={DownloadSimpleIcon}
                        loading={exportSlips.isPending}
                        disabled={!firstPage || firstPage.total === 0}
                        onClick={() => exportSlips.mutate()}
                      >
                        {common("export")}
                      </Button>
                    ) : undefined
                  }
                />
                <DataTable
                  id="period-payslips"
                  cardLead="employee"
                  cardTrailing="net"
                  columns={slipColumns}
                  rows={slipRows}
                  keyOf={(row) => row.id}
                  pending={slips.isPending}
                  failed={slips.isError}
                  onRetry={() => void slips.refetch()}
                  onRowClick={setSlipOpen}
                  empty={url.q ? common("noMatch") : t("empty")}
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
              </>
            ) : (
              <LayerCard className="p-0">
                <Empty
                  icon={<ReceiptIcon size={40} className="text-kumo-inactive" />}
                  title={t("slipsNone")}
                  description={t("slipsNoneHint")}
                  className="py-10"
                />
              </LayerCard>
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
              <Radio.Group legend={t("runKind")} appearance="card" value={kind} onValueChange={(next) => setKind(next as RunKind)}>
                {KINDS.map((one) => (
                  <Radio.Item key={one} value={one} label={t(`run${one}`)} description={t(KIND_HINT[one])} />
                ))}
              </Radio.Group>
              <Input
                label={optional(t("runLabel"))}
                description={t("runLabelHint")}
                maxLength={kLabelMax}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
              <FaultBanner fault={fault} />
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
              <FaultBanner fault={fault} />
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
            <div className="flex flex-col gap-3">
              <p className="text-kumo-subtle">{t("payNote")}</p>
              <FaultBanner fault={fault} />
            </div>
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
            <div className="flex flex-col gap-3">
              <p className="text-kumo-subtle">{t("deliverNote")}</p>
              <FaultBanner fault={fault} />
            </div>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary variant="destructive" loading={deliver.isPending} onClick={() => deliver.mutate()}>
              {t("deliverGo")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>

      <LayerDialog.Root open={slipOpen !== null} onOpenChange={(next) => !next && setSlipOpen(null)}>
        <LayerDialog.Content size="lg" closeLabel={common("close")}>
          <LayerDialog.Title>{slipOpen ? t("slipOf", { name: slipOpen.employee.fullName }) : t("payslips")}</LayerDialog.Title>
          <LayerDialog.Description>{t("periodTitle", { period: name })}</LayerDialog.Description>
          <LayerDialog.Body>
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
          </LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}

export default function PayrollPeriodPage() {
  return (
    <Suspense>
      <PayrollPeriod />
    </Suspense>
  );
}
