"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";
import { money } from "@/lib/format";

const REASONS = ["HIRE", "PROMOTION", "ANNUAL_REVIEW", "ADJUSTMENT", "TRANSFER", "OTHER"] as const;

type Reason = (typeof REASONS)[number];

interface PayslipPage {
  rows: PayslipRow[];
  total: number;
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
  netPay: string;
  period?: { year: number; month: number };
}

function day(value: string): string {
  return value.slice(0, 10);
}

function firstOfNextMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10);
}

export function Pay({ employeeId, mayWrite }: { employeeId: number; mayWrite: boolean }) {
  const t = useTranslations("employees");
  const common = useTranslations("common");
  const locale = useLocale();
  const cache = useQueryClient();
  const faultOf = useFault();

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
      setNote("");
      void cache.invalidateQueries({ queryKey: ["compensation", employeeId] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    setFault(null);
    add.mutate();
  }

  // A raise adds a row with its own effective date (KEHOACH 4.9).
  function copyFrom(): void {
    const latest = rows.data?.[0];
    setBaseSalary(latest ? String(Math.trunc(Number(latest.baseSalary))) : "");
    setInsuranceSalary(latest ? String(Math.trunc(Number(latest.insuranceSalary))) : "");
    setEffectiveFrom(firstOfNextMonth());
    setFault(null);
    setOpen(true);
  }

  return (
    <div className="mt-4 flex flex-col gap-6">
      <section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">{t("payHistory")}</h2>
          {mayWrite ? (
            <Button type="button" size="sm" onClick={copyFrom}>
              {t("payAdd")}
            </Button>
          ) : null}
        </div>
        <div className="mt-2 rounded-xl border border-(--color-line) bg-(--color-surface)">
          {rows.isPending ? (
            <p className="px-4 py-6 text-sm text-(--color-muted)">{common("loading")}</p>
          ) : rows.data?.length ? (
            <ul className="divide-y divide-(--color-line)">
              {rows.data.map((one) => (
                <li key={one.id} className="flex flex-wrap gap-3 px-4 py-2 text-sm">
                  <span className="tabular-nums">{day(one.effectiveFrom)}</span>
                  <span className="text-xs text-(--color-muted)">{t(`payReason${one.reason}`)}</span>
                  <span className="ms-auto tabular-nums">
                    {t("payBase")} {money(Number(one.baseSalary), locale)}
                  </span>
                  <span className="tabular-nums text-(--color-muted)">
                    {t("payInsurance")} {money(Number(one.insuranceSalary), locale)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-6 text-sm text-(--color-muted)">
              {rows.isPending ? common("loading") : t("payEmpty")}
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium">{t("payslipsHere")}</h2>
        <div className="mt-2 rounded-xl border border-(--color-line) bg-(--color-surface)">
          {payslips.isPending ? (
            <p className="px-4 py-6 text-sm text-(--color-muted)">{common("loading")}</p>
          ) : slips?.length ? (
            <ul className="divide-y divide-(--color-line)">
              {slips.map((one) => (
                <li key={one.id} className="flex gap-3 px-4 py-2 text-sm">
                  <span className="tabular-nums">
                    {one.period ? `${one.period.month}/${one.period.year}` : ""}
                  </span>
                  <span className="ms-auto tabular-nums">{money(Number(one.netPay), locale)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-6 text-sm text-(--color-muted)">{t("payslipsEmpty")}</p>
          )}
          {payslips.hasNextPage ? (
            <div className="border-t border-(--color-line) p-2">
              <Button
                type="button"
                tone="quiet"
                size="sm"
                className="w-full"
                disabled={payslips.isFetchingNextPage}
                onClick={() => void payslips.fetchNextPage()}
              >
                {payslips.isFetchingNextPage ? common("loading") : common("loadMore")}
              </Button>
            </div>
          ) : null}
        </div>
      </section>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={t("payAdd")}
        closeLabel={common("close")}
      >
        <form onSubmit={submit}>
          <label className="block text-sm font-medium" htmlFor="payFrom">
            {t("payFrom")}
          </label>
          <Input
            id="payFrom"
            type="date"
            required
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
            className="mt-1"
          />

          <label className="mt-4 block text-sm font-medium" htmlFor="payBase">
            {t("payBase")}
          </label>
          <Input
            id="payBase"
            type="number"
            inputMode="numeric"
            min={0}
            required
            value={baseSalary}
            onChange={(event) => setBaseSalary(event.target.value)}
            className="mt-1"
          />
          {baseSalary !== "" && Number(baseSalary) > 0 ? (
            <p className="mt-1 text-xs text-(--color-muted) tabular-nums">
              {money(Number(baseSalary), locale)}
            </p>
          ) : null}

          <label className="mt-4 block text-sm font-medium" htmlFor="payInsurance">
            {t("payInsurance")}
          </label>
          <Input
            id="payInsurance"
            type="number"
            inputMode="numeric"
            min={0}
            required
            value={insuranceSalary}
            onChange={(event) => setInsuranceSalary(event.target.value)}
            className="mt-1"
          />
          {insuranceSalary !== "" && Number(insuranceSalary) > 0 ? (
            <p className="mt-1 text-xs text-(--color-muted) tabular-nums">
              {money(Number(insuranceSalary), locale)}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-(--color-muted)">{t("payInsuranceHint")}</p>

          <label className="mt-4 block text-sm font-medium" htmlFor="payReason">
            {t("payReason")}
          </label>
          <Select
            id="payReason"
            value={reason}
            onChange={(event) => setReason(event.target.value as Reason)}
            className="mt-1"
          >
            {REASONS.map((one) => (
              <option key={one} value={one}>
                {t(`payReason${one}`)}
              </option>
            ))}
          </Select>

          <label className="mt-4 block text-sm font-medium" htmlFor="payNote">
            {t("contractNote")}
          </label>
          <Input
            id="payNote"
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="mt-1"
          />

          {fault ? (
            <p role="alert" className="mt-3 text-sm text-(--color-danger)">
              {fault}
            </p>
          ) : null}
          <Button type="submit" disabled={add.isPending} className="mt-4">
            {add.isPending ? common("saving") : common("save")}
          </Button>
        </form>
      </Sheet>
    </div>
  );
}
