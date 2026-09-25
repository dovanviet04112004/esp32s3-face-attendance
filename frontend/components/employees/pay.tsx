"use client";

import { Banner, Button, Input, LayerDialog, Select } from "@cloudflare/kumo";
import { PlusIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { useNotify } from "@/components/ui/notify";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";
import { dayOnly, money } from "@/lib/format";

const REASONS = ["HIRE", "PROMOTION", "ANNUAL_REVIEW", "ADJUSTMENT", "TRANSFER", "OTHER"] as const;

type Reason = (typeof REASONS)[number];

interface PayslipPage {
  rows: PayslipRow[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
}

interface PayRecord {
  id: string;
  effectiveFrom: string;
  baseSalary: string;
  insuranceSalary: string;
  reason: Reason;
}

interface PayslipRow {
  id: string;
  grossPay: string;
  netPay: string;
  period?: { year: number; month: number };
}

function firstOfNextMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

export function Pay({ employeeId, mayWrite }: { employeeId: number; mayWrite: boolean }) {
  const t = useTranslations("employees");
  const common = useTranslations("common");
  const locale = useLocale();
  const format = useFormatter();
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();

  const [open, setOpen] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState(firstOfNextMonth);
  const [baseSalary, setBaseSalary] = useState("");
  const [insuranceSalary, setInsuranceSalary] = useState("");
  const [reason, setReason] = useState<Reason>("ANNUAL_REVIEW");
  const [note, setNote] = useState("");

  const rows = useQuery({
    queryKey: ["compensation", employeeId],
    queryFn: async () => (await api.get<PayRecord[]>(`/employees/${employeeId}/compensation`)).data,
  });

  const payslips = useInfiniteQuery({
    queryKey: ["payslips", "of", employeeId],
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const after = pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : "";
      return (await api.get<PayslipPage>(`/payslips?employeeId=${employeeId}${after}`)).data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const slips = payslips.data?.pages.flatMap((one) => one.rows);
  const firstSlips = payslips.data?.pages[0];

  const add = useMutation({
    mutationFn: () =>
      api.post("/compensation", {
        employeeId,
        effectiveFrom,
        baseSalary: Number(baseSalary),
        insuranceSalary: Number(insuranceSalary),
        reason,
        note: note || undefined,
      }),
    onSuccess: () => {
      setOpen(false);
      notify.done(t("payAdded"));
      void cache.invalidateQueries({ queryKey: ["compensation", employeeId] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  // A raise adds a row with its own effective date (KEHOACH 4.9).
  function copyFrom(): void {
    const latest = rows.data?.[0];
    setBaseSalary(latest ? String(Math.trunc(Number(latest.baseSalary))) : "");
    setInsuranceSalary(latest ? String(Math.trunc(Number(latest.insuranceSalary))) : "");
    setEffectiveFrom(firstOfNextMonth());
    setReason(latest ? "ANNUAL_REVIEW" : "HIRE");
    setNote("");
    setFault(null);
    setOpen(true);
  }

  const amount = (value: string) => money(Number(value), locale);
  const month = (at: { year: number; month: number }) =>
    format.dateTime(new Date(Date.UTC(at.year, at.month - 1, 15)), { month: "long", year: "numeric" });

  const history: Column<PayRecord>[] = [
    {
      id: "from",
      header: t("payFrom"),
      sortBy: (row) => row.effectiveFrom,
      cell: (row) => <span className="tabular-nums">{format.dateTime(dayOnly(row.effectiveFrom), "day")}</span>,
    },
    { id: "reason", header: t("payReason"), cell: (row) => t(`payReason${row.reason}`) },
    { id: "base", header: t("payBase"), numeric: true, sortBy: (row) => Number(row.baseSalary), cell: (row) => amount(row.baseSalary) },
    {
      id: "insurance",
      header: t("payInsurance"),
      numeric: true,
      sortBy: (row) => Number(row.insuranceSalary),
      cell: (row) => amount(row.insuranceSalary),
    },
  ];

  const slipColumns: Column<PayslipRow>[] = [
    { id: "period", header: t("payslipPeriod"), cell: (row) => (row.period ? month(row.period) : common("empty")) },
    { id: "gross", header: t("payslipGross"), numeric: true, cell: (row) => amount(row.grossPay) },
    { id: "net", header: t("payslipNet"), numeric: true, cell: (row) => amount(row.netPay) },
  ];

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0 text-lg font-semibold">{t("payHistory")}</h2>
          {mayWrite ? (
            <Button variant="secondary" icon={PlusIcon} onClick={copyFrom}>
              {t("payAdd")}
            </Button>
          ) : null}
        </div>
        <DataTable
          id="employee-pay"
          cardLead="from"
          columns={history}
          rows={rows.data}
          keyOf={(row) => row.id}
          pending={rows.isPending}
          failed={rows.isError}
          onRetry={() => void rows.refetch()}
          empty={t("payEmpty")}
          emptyHint={mayWrite ? t("payEmptyHint") : undefined}
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="m-0 text-lg font-semibold">{t("payslipsHere")}</h2>
        <DataTable
          id="employee-payslips"
          cardLead="period"
          columns={slipColumns}
          rows={slips}
          keyOf={(row) => row.id}
          pending={payslips.isPending}
          failed={payslips.isError}
          onRetry={() => void payslips.refetch()}
          empty={t("payslipsEmpty")}
          paging={
            firstSlips && firstSlips.total > 0
              ? {
                  shown: slips?.length ?? 0,
                  total: firstSlips.total,
                  exact: firstSlips.totalIsExact,
                  onMore: payslips.hasNextPage ? () => void payslips.fetchNextPage() : undefined,
                  loading: payslips.isFetchingNextPage,
                }
              : undefined
          }
        />
      </section>

      <LayerDialog.Root open={open} onOpenChange={setOpen} dismissDisabled={add.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("payAdd")}</LayerDialog.Title>
          <LayerDialog.Description>{t("payAddLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <form
              id="pay-add"
              className="grid items-start gap-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                setFault(null);
                add.mutate();
              }}
            >
              <Input
                label={t("payFrom")}
                type="date"
                required
                value={effectiveFrom}
                onChange={(event) => setEffectiveFrom(event.target.value)}
              />
              <Select
                label={t("payReason")}
                hideLabel={false}
                value={reason}
                onValueChange={(next) => setReason(String(next ?? "OTHER") as Reason)}
                items={Object.fromEntries(REASONS.map((one) => [one, t(`payReason${one}`)]))}
                className="w-full"
              />
              <Input
                label={t("payBase")}
                description={Number(baseSalary) > 0 ? amount(baseSalary) : undefined}
                type="number"
                inputMode="numeric"
                min={0}
                required
                value={baseSalary}
                onChange={(event) => setBaseSalary(event.target.value)}
                className="tabular-nums"
              />
              <Input
                label={t("payInsurance")}
                description={Number(insuranceSalary) > 0 ? amount(insuranceSalary) : t("payInsuranceHint")}
                type="number"
                inputMode="numeric"
                min={0}
                required
                value={insuranceSalary}
                onChange={(event) => setInsuranceSalary(event.target.value)}
                className="tabular-nums"
              />
              <div className="sm:col-span-2">
                <Input label={t("contractNote")} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
              </div>
            </form>
            {fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} className="mt-4" /> : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary type="submit" form="pay-add" loading={add.isPending}>
              {t("payAdd")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </div>
  );
}
