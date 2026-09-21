"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { RequestForm } from "@/components/requests/request-form";
import { RequestCard, type RequestRow } from "@/components/requests/request-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { useOutbox } from "@/lib/outbox";
import { money } from "@/lib/format";

type AdvanceState = "PENDING" | "APPROVED" | "REJECTED" | "PAID" | "SETTLED" | "CANCELLED";

interface Advance {
  id: string;
  amount: string;
  reason: string;
  state: AdvanceState;
  decisionNote: string | null;
}

const ADVANCE_KEY: Record<
  AdvanceState,
  | "advancePENDING"
  | "advanceAPPROVED"
  | "advanceREJECTED"
  | "advancePAID"
  | "advanceSETTLED"
  | "advanceCANCELLED"
> = {
  PENDING: "advancePENDING",
  APPROVED: "advanceAPPROVED",
  REJECTED: "advanceREJECTED",
  PAID: "advancePAID",
  SETTLED: "advanceSETTLED",
  CANCELLED: "advanceCANCELLED",
};

export default function MyRequestsPage() {
  const t = useTranslations("requests");
  const pay = useTranslations("payroll");
  const locale = useLocale();
  const faultOf = useFault();
  const common = useTranslations("common");
  const cache = useQueryClient();
  const employeeId = useSession((s) => s.employeeId);
  const [filing, setFiling] = useState(false);
  const [amount, setAmount] = useState("");
  const [why, setWhy] = useState("");
  const [advanceFault, setAdvanceFault] = useState<string | null>(null);
  const waiting = useOutbox();

  const mine = useQuery({
    queryKey: ["requests", "mine", employeeId],
    enabled: employeeId !== null,
    queryFn: async () =>
      (await api.get<{ rows: RequestRow[]; total: number }>(`/requests?employeeId=${employeeId}`))
        .data,
  });

  const advances = useQuery({
    queryKey: ["advances"],
    queryFn: async () => (await api.get<Advance[]>("/advances")).data,
  });

  const ask = useMutation({
    mutationFn: () => api.post("/advances", { amount: Number(amount), reason: why }),
    onSuccess: () => {
      setAmount("");
      setWhy("");
      void cache.invalidateQueries({ queryKey: ["advances"] });
    },
    onError: (fell: unknown) => setAdvanceFault(faultOf(fell)),
  });

  const drop = useMutation({
    mutationFn: (id: string) => api.post(`/advances/${id}/cancel`, {}),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["advances"] }),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/requests/${id}/cancel`, {}),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["requests"] }),
  });

  return (
    <section className="max-w-3xl">
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-lg font-semibold">{t("mine")}</h1>
        {!filing ? (
          <Button size="sm" onClick={() => setFiling(true)}>
            {t("new")}
          </Button>
        ) : null}
      </div>

      {waiting.length > 0 ? (
        <p
          role="status"
          className="mt-4 rounded-lg border border-(--color-warn) px-3 py-2 text-sm text-(--color-warn)"
        >
          {t("waitingToSend", { count: waiting.length })}
        </p>
      ) : null}

      {filing ? (
        <div className="mt-6">
          <RequestForm
            onDone={() => {
              setFiling(false);
              void cache.invalidateQueries({ queryKey: ["requests"] });
            }}
            onCancel={() => setFiling(false)}
          />
        </div>
      ) : null}

      <div className="mt-6 flex flex-col gap-3">
        {mine.isPending ? (
          <p className="text-sm text-(--color-muted)">{common("loading")}</p>
        ) : mine.data && mine.data.rows.length > 0 ? (
          mine.data.rows.map((row) => (
            <RequestCard
              key={row.id}
              row={row}
              busy={cancel.isPending}
              onCancel={() => cancel.mutate(row.id)}
            />
          ))
        ) : (
          <p className="text-sm text-(--color-muted)">{t("mineEmpty")}</p>
        )}
      </div>

      <h2 className="mt-8 text-sm font-semibold">{pay("advances")}</h2>
      <p className="mt-1 text-sm text-(--color-muted)">{pay("advanceLead")}</p>

      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setAdvanceFault(null);
          ask.mutate();
        }}
      >
        <Input
          aria-label={pay("advanceAmount")}
          type="number"
          min={1}
          required
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          className="w-40"
        />
        <Input
          aria-label={t("reason")}
          required
          maxLength={500}
          value={why}
          onChange={(event) => setWhy(event.target.value)}
          className="min-w-48 flex-1"
        />
        <Button type="submit" disabled={ask.isPending}>
          {ask.isPending ? common("saving") : pay("advanceNew")}
        </Button>
      </form>
      {advanceFault ? (
        <p role="alert" className="mt-2 text-sm text-(--color-danger)">
          {advanceFault}
        </p>
      ) : null}

      <div className="mt-3 flex flex-col gap-2">
        {advances.data?.length ? (
          advances.data.map((row) => (
            <article
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-(--color-line) bg-(--color-surface) p-3 text-sm"
            >
              <span className="tabular-nums">{money(Number(row.amount), locale)}</span>
              <span className="min-w-0 flex-1 truncate text-(--color-muted)">{row.reason}</span>
              <span className="rounded-full border border-(--color-line) px-2 py-0.5 text-xs">
                {pay(ADVANCE_KEY[row.state])}
              </span>
              {row.state === "PENDING" ? (
                <Button
                  type="button"
                  tone="quiet"
                  size="sm"
                  disabled={drop.isPending}
                  onClick={() => drop.mutate(row.id)}
                >
                  {t("cancel")}
                </Button>
              ) : null}
            </article>
          ))
        ) : (
          <p className="text-sm text-(--color-muted)">{pay("advanceEmpty")}</p>
        )}
      </div>
    </section>
  );
}
