"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { DisputeCard, type Dispute, type Verdict } from "@/components/payroll/dispute-card";
import { RequestCard, type RequestRow } from "@/components/requests/request-card";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";

const DEPENDENT_DECIDERS = ["ADMIN", "PAYROLL"];
const DISPUTE_ANSWERERS = ["ADMIN", "PAYROLL"];
const RELATIONS = ["CHILD", "SPOUSE", "PARENT", "SIBLING", "OTHER"] as const;

interface WaitingDependent {
  id: string;
  fullName: string;
  relation: (typeof RELATIONS)[number];
  fromMonth: string;
  employee: { id: number; code: string; fullName: string };
}

export default function ApprovalsPage() {
  const t = useTranslations("requests");
  const me = useTranslations("me");
  const d = useTranslations("disputes");
  const common = useTranslations("common");
  const cache = useQueryClient();
  const role = useSession((s) => s.role);
  const mayDecideDependents = role !== null && DEPENDENT_DECIDERS.includes(role);
  const mayAnswerDisputes = role !== null && DISPUTE_ANSWERERS.includes(role);

  const inbox = useQuery({
    queryKey: ["requests", "inbox"],
    queryFn: async () =>
      (await api.get<{ rows: RequestRow[]; total: number }>("/requests/inbox")).data,
  });

  const decide = useMutation({
    mutationFn: (what: { id: string; approve: boolean; note: string }) =>
      api.post(`/requests/${what.id}/decide`, { approve: what.approve, note: what.note || undefined }),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["requests"] });
    },
  });

  const dependents = useQuery({
    queryKey: ["dependents", "waiting"],
    enabled: mayDecideDependents,
    queryFn: async () =>
      (await api.get<WaitingDependent[]>("/dependents?state=PENDING")).data,
  });

  const decideDependent = useMutation({
    mutationFn: (what: { id: string; approve: boolean }) =>
      api.post(`/dependents/${what.id}/decide`, { approve: what.approve }),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["dependents"] }),
  });

  const waitingDisputes = useQuery({
    queryKey: ["payslip-disputes", "waiting"],
    enabled: mayAnswerDisputes,
    queryFn: async () =>
      (await api.get<{ rows: Dispute[] }>("/payslip-disputes?state=OPEN")).data.rows,
  });

  const answer = useMutation({
    mutationFn: (verdict: Verdict) =>
      api.post(`/payslip-disputes/${verdict.id}/answer`, {
        outcome: verdict.outcome,
        answer: verdict.answer,
        ...(verdict.amount === undefined ? {} : { amount: verdict.amount }),
      }),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["payslip-disputes"] }),
  });

  return (
    <section className="max-w-3xl">
      <h1 className="text-lg font-semibold">{t("inbox")}</h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">
        {inbox.data ? `${inbox.data.total}` : " "}
      </p>

      {inbox.isPending ? (
        <p className="text-sm text-(--color-muted)">{common("loading")}</p>
      ) : inbox.data && inbox.data.rows.length > 0 ? (
        <div className="flex flex-col gap-3">
          {inbox.data.rows.map((row) => (
            <RequestCard
              key={row.id}
              row={row}
              busy={decide.isPending}
              onDecide={(approve, note) => decide.mutate({ id: row.id, approve, note })}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-(--color-muted)">{t("inboxEmpty")}</p>
      )}
      {mayDecideDependents && dependents.data?.length ? (
        <>
          <h2 className="mt-8 text-sm font-medium">{me("dependentsTitle")}</h2>
          <div className="mt-2 rounded-xl border border-(--color-line) bg-(--color-surface)">
            <ul className="divide-y divide-(--color-line)">
              {dependents.data.map((one) => (
                <li key={one.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {one.employee.fullName} · {one.fullName}
                  </span>
                  <span className="text-(--color-muted)">{me(`relation${one.relation}`)}</span>
                  <span className="tabular-nums text-(--color-muted)">
                    {one.fromMonth.slice(0, 10)}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={decideDependent.isPending}
                    onClick={() => decideDependent.mutate({ id: one.id, approve: true })}
                  >
                    {t("approve")}
                  </Button>
                  <Button
                    type="button"
                    tone="quiet"
                    size="sm"
                    disabled={decideDependent.isPending}
                    onClick={() => decideDependent.mutate({ id: one.id, approve: false })}
                  >
                    {t("reject")}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}

      {mayAnswerDisputes ? (
        <>
          <h2 className="mt-8 text-sm font-medium">{d("inboxTitle")}</h2>
          {waitingDisputes.data?.length ? (
            <ul className="mt-2 flex flex-col gap-2">
              {waitingDisputes.data.map((one) => (
                <DisputeCard
                  key={one.id}
                  dispute={one}
                  mayAnswer
                  busy={answer.isPending}
                  onAnswer={(verdict) => answer.mutate(verdict)}
                />
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-(--color-muted)">{d("inboxEmpty")}</p>
          )}
        </>
      ) : null}
    </section>
  );
}
