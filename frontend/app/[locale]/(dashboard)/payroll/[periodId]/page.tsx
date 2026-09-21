"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useState } from "react";

import { BonusSheet } from "@/components/payroll/bonus-sheet";
import { RunProgress, type PayrollRun } from "@/components/payroll/run-progress";
import { SettlementSheet } from "@/components/payroll/settlement-sheet";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, Failed } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";

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

type ItemKey = "REQUESTS_PENDING";

export default function PayrollRunPage() {
  const t = useTranslations("payroll");
  const common = useTranslations("common");
  const params = useParams<{ periodId: string }>();
  const periodId = params.periodId;
  const role = useSession((s) => s.role);
  const mayWrite = role === "ADMIN" || role === "PAYROLL";
  const cache = useQueryClient();
  const [label, setLabel] = useState("");
  const [accept, setAccept] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  // Mail reaches everyone in the period and cannot be recalled, so it asks.
  const [sending, setSending] = useState(false);
  const faultOf = useFault();

  const periods = useQuery({
    queryKey: ["payroll-periods"],
    queryFn: async () => (await api.get<Period[]>("/payroll-periods")).data,
  });
  const period = periods.data?.find((one) => one.id === periodId);

  const checklist = useQuery({
    queryKey: ["payroll-periods", periodId, "checklist"],
    queryFn: async () =>
      (await api.get<ChecklistItem[]>(`/payroll-periods/${periodId}/checklist`)).data,
  });

  const runs = useQuery({
    queryKey: ["payroll-periods", periodId, "runs"],
    refetchInterval: (query) =>
      (query.state.data ?? []).some((run) => run.state === "RUNNING") ? 2000 : false,
    queryFn: async () =>
      (await api.get<PayrollRun[]>(`/payroll-periods/${periodId}/runs`)).data,
  });

  function refresh(): void {
    void cache.invalidateQueries({ queryKey: ["payroll-periods"] });
  }

  const create = useMutation({
    mutationFn: (kind: "REGULAR" | "BONUS" | "FINAL_SETTLEMENT") =>
      api.post("/payroll-runs", { periodId, kind, label: label || undefined }),
    onSuccess: () => {
      setLabel("");
      refresh();
    },
  });

  const execute = useMutation({
    mutationFn: (runId: string) => api.post(`/payroll-runs/${runId}/execute`),
    onSuccess: refresh,
  });

  const lock = useMutation({
    mutationFn: () =>
      api.post(`/payroll-periods/${periodId}/lock`, { acceptOpenItems: accept }),
    onSuccess: refresh,
  });

  const pay = useMutation({
    mutationFn: () => api.post(`/payroll-periods/${periodId}/paid`),
    onSuccess: refresh,
  });

  const exportFile = useMutation({
    mutationFn: async (kind: "bank" | "ledger") => {
      const file = (
        await api.get<string>(`/payroll-periods/${periodId}/export?kind=${kind}`)
      ).data;
      const link = document.createElement("a");
      // The api already opens the file with a BOM, so this must not add one.
      link.href = URL.createObjectURL(new Blob([file], { type: "text/csv;charset=utf-8" }));
      link.download = `payroll-${kind}-${periodId}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const deliver = useMutation({
    mutationFn: async () =>
      (await api.post<{ queued: number }>(`/payroll-periods/${periodId}/deliver`)).data,
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  if (periods.isError) {
    return <Failed onRetry={() => periods.refetch()} />;
  }

  const openItems = (checklist.data ?? []).filter((item) => item.count > 0);

  return (
    <section>
      <h1 className="mt-2 text-lg font-semibold">
        {period ? `${String(period.month).padStart(2, "0")}/${period.year}` : t("period")}
      </h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">{t("lockLead")}</p>

      <section className="rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
        <h2 className="text-sm font-medium">{t("checklist")}</h2>
        {checklist.isPending ? (
          <SkeletonRows rows={2} columns={2} />
        ) : openItems.length === 0 ? (
          <p className="mt-2 text-sm text-(--color-ok)">{t("checklistClear")}</p>
        ) : (
          <dl className="mt-2 flex flex-col">
            {openItems.map((item) => (
              <div
                key={item.code}
                className="flex justify-between gap-3 border-b border-(--color-line) py-2 text-sm last:border-0"
              >
                <dt>{t(item.code as ItemKey)}</dt>
                <dd className="text-(--color-warn) tabular-nums">{item.count}</dd>
              </div>
            ))}
          </dl>
        )}

        {mayWrite && period?.state === "OPEN" ? (
          <div className="mt-4">
            {openItems.length > 0 ? (
              <Checkbox
                checked={accept}
                onChange={(event) => setAccept(event.target.checked)}
                label={t("acceptOpen")}
              />
            ) : null}
            <Button
              type="button"
              className="mt-2"
              disabled={lock.isPending || (openItems.length > 0 && !accept)}
              onClick={() => lock.mutate()}
            >
              {lock.isPending ? common("saving") : t("lock")}
            </Button>
          </div>
        ) : null}

        {mayWrite && period?.state === "LOCKED" ? (
          <Button
            type="button"
            tone="quiet"
            className="mt-4"
            disabled={pay.isPending}
            onClick={() => pay.mutate()}
          >
            {pay.isPending ? common("saving") : t("markPaid")}
          </Button>
        ) : null}
      </section>

      {mayWrite && period && period.state !== "OPEN" ? (
        <section className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
          <h2 className="text-sm font-medium">{t("payoutTitle")}</h2>
          <p className="mt-1 text-sm text-(--color-muted)">{t("payoutLead")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              tone="quiet"
              disabled={exportFile.isPending}
              onClick={() => {
                setFault(null);
                exportFile.mutate("bank");
              }}
            >
              {t("exportBank")}
            </Button>
            <Button
              type="button"
              tone="quiet"
              disabled={exportFile.isPending}
              onClick={() => {
                setFault(null);
                exportFile.mutate("ledger");
              }}
            >
              {t("exportLedger")}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setFault(null);
                setSending(true);
              }}
            >
              {t("deliver")}
            </Button>
          </div>
          {deliver.data ? (
            <p className="mt-2 text-sm text-(--color-ok)">
              {t("delivered", { count: deliver.data.queued })}
            </p>
          ) : null}
          {fault ? (
            <p role="alert" className="mt-2 text-sm text-(--color-danger)">
              {fault}
            </p>
          ) : null}
        </section>
      ) : null}

      <Sheet
        open={sending}
        onClose={() => setSending(false)}
        title={t("deliver")}
        closeLabel={common("close")}
      >
        <p className="text-sm text-(--color-muted)">{t("deliverWarn")}</p>
        <Button
          type="button"
          className="mt-4 w-full"
          disabled={deliver.isPending}
          onClick={() => {
            deliver.mutate(undefined, { onSuccess: () => setSending(false) });
          }}
        >
          {deliver.isPending ? common("saving") : t("deliverGo")}
        </Button>
      </Sheet>

      <h2 className="mt-6 text-sm font-medium">{t("runs")}</h2>
      {mayWrite && period?.state === "OPEN" ? (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate("REGULAR");
          }}
        >
          <Input
            aria-label={t("newRun")}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            className="max-w-xs flex-1"
          />
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? common("saving") : t("newRun")}
          </Button>
          <Button
            type="button"
            tone="quiet"
            disabled={create.isPending}
            onClick={() => create.mutate("BONUS")}
          >
            {t("newBonus")}
          </Button>
          <Button
            type="button"
            tone="quiet"
            disabled={create.isPending}
            onClick={() => create.mutate("FINAL_SETTLEMENT")}
          >
            {t("newSettlement")}
          </Button>
        </form>
      ) : null}

      <div className="mt-3 flex flex-col gap-2">
        {runs.isPending ? (
          <SkeletonRows rows={2} columns={3} />
        ) : !runs.data?.length ? (
          <Empty title={t("empty")} hint={t("emptyHint")} />
        ) : (
          runs.data.map((run) => (
            <div key={run.id}>
            <RunProgress
              run={run}
              action={
                <div className="flex flex-wrap gap-2">
                  {mayWrite && period?.state === "OPEN" ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={execute.isPending || run.state === "RUNNING"}
                      onClick={() => execute.mutate(run.id)}
                    >
                      {run.state === "RUNNING" ? t("running") : t("run")}
                    </Button>
                  ) : null}
                  {run.doneCount > 0 ? (
                    <Link href={`/payroll/${periodId}?runId=${run.id}`}>
                      <Button type="button" tone="quiet" size="sm">
                        {t("payslips")}
                      </Button>
                    </Link>
                  ) : null}
                </div>
              }
            />
            {run.kind === "BONUS" ? (
              <div className="mt-2 ms-4">
                <BonusSheet
                  runId={run.id}
                  editable={mayWrite && period?.state === "OPEN" && run.state !== "RUNNING"}
                />
              </div>
            ) : null}
            {run.kind === "FINAL_SETTLEMENT" ? (
              <div className="mt-2 ms-4">
                <p className="mb-2 text-sm text-(--color-muted)">{t("settlementLead")}</p>
                <SettlementSheet
                  runId={run.id}
                  editable={mayWrite && period?.state === "OPEN" && run.state !== "RUNNING"}
                />
              </div>
            ) : null}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
