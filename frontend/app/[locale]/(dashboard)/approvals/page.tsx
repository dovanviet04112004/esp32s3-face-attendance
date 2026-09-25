"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { CountPill } from "@/components/ui/pill";
import { Failed } from "@/components/ui/empty";
import { DisputeCard, type Dispute, type Verdict } from "@/components/payroll/dispute-card";
import { RequestCard, type RequestRow } from "@/components/requests/request-card";
import { Button } from "@/components/ui/button";
import {
  ADVANCE_DECIDERS,
  ADVANCE_PAYERS,
  DEPENDENT_DECIDERS,
  DISPUTE_ANSWERERS,
  LETTER_DESK,
  PROFILE_DESK,
  WAITING_POLL_MS,
} from "@/components/nav/waiting-count";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { dayOnly, money } from "@/lib/format";

const RELATIONS = ["CHILD", "SPOUSE", "PARENT", "SIBLING", "OTHER"] as const;

interface WaitingDependent {
  id: string;
  fullName: string;
  relation: (typeof RELATIONS)[number];
  fromMonth: string;
  employee: { id: number; code: string; fullName: string };
}

interface Letter {
  id: string;
  kind: "EMPLOYMENT" | "INCOME";
  purpose: string;
  employee?: { code: string; fullName: string };
}

interface WaitingAdvance {
  id: string;
  amount: string;
  reason: string;
  employee?: { code: string; fullName: string };
}

interface ProfileChange {
  id: string;
  field: "PERSONAL_EMAIL" | "PHONE" | "BANK" | "NATIONAL_ID" | "TAX_CODE" | "SOCIAL_INSURANCE_NO";
  oldValue: Record<string, string | null> | null;
  newValue: Record<string, string | null>;
  employee?: { code: string; fullName: string };
}

function reads(values: Record<string, string | null> | null, blank: string): string {
  const shown = Object.values(values ?? {}).filter((one) => one !== null && one !== "");
  return shown.length > 0 ? shown.join(" · ") : blank;
}

function Queue({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (count === 0) {
    return null;
  }
  return (
    <section className="mt-8">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        {title}
        <CountPill>{count}</CountPill>
      </h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return (
    <ul className="divide-y divide-(--color-line) rounded-xl border border-(--color-line) bg-(--color-surface)">
      {children}
    </ul>
  );
}

// Stacked on a phone so the buttons keep a whole line to themselves; wrapping
// them mid-row is what put a decision under a name (KEHOACH 9.21.2).
function Row({ lead, aside, children }: { lead: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:gap-3">
      <span className="min-w-0 flex-1 truncate">{lead}</span>
      {aside === undefined ? null : <span className="shrink-0 sm:text-right">{aside}</span>}
      <span className="flex shrink-0 gap-2">{children}</span>
    </li>
  );
}

export default function ApprovalsPage() {
  const t = useTranslations("requests");
  const format = useFormatter();
  const me = useTranslations("me");
  const d = useTranslations("disputes");
  const c = useTranslations("certificates");
  const p = useTranslations("profile");
  const pay = useTranslations("payroll");
  const common = useTranslations("common");
  const locale = useLocale();
  const cache = useQueryClient();
  const role = useSession((s) => s.role);
  const mayDecideDependents = role !== null && DEPENDENT_DECIDERS.includes(role);
  const mayAnswerDisputes = role !== null && DISPUTE_ANSWERERS.includes(role);
  const mayIssueLetters = role !== null && LETTER_DESK.includes(role);
  const mayDecideProfile = role !== null && PROFILE_DESK.includes(role);
  const mayDecideAdvances = role !== null && ADVANCE_DECIDERS.includes(role);
  const mayPayAdvances = role !== null && ADVANCE_PAYERS.includes(role);

  const inbox = useQuery({
    queryKey: ["requests", "inbox"],
    refetchInterval: WAITING_POLL_MS,
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
    refetchInterval: WAITING_POLL_MS,
    enabled: mayDecideDependents,
    queryFn: async () =>
      (await api.get<{ rows: WaitingDependent[] }>("/dependents?state=PENDING")).data.rows,
  });

  const decideDependent = useMutation({
    mutationFn: (what: { id: string; approve: boolean }) =>
      api.post(`/dependents/${what.id}/decide`, { approve: what.approve }),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["dependents"] }),
  });

  const waitingDisputes = useQuery({
    queryKey: ["payslip-disputes", "waiting"],
    refetchInterval: WAITING_POLL_MS,
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

  const letters = useQuery({
    queryKey: ["certificates", "waiting"],
    refetchInterval: WAITING_POLL_MS,
    enabled: mayIssueLetters,
    queryFn: async () =>
      (await api.get<{ rows: Letter[] }>("/certificates?state=REQUESTED")).data.rows,
  });

  const decideLetter = useMutation({
    mutationFn: (what: { id: string; how: "issue" | "reject" }) =>
      api.post(`/certificates/${what.id}/${what.how}`, {}),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["certificates"] }),
  });

  const changes = useQuery({
    queryKey: ["profile-changes", "waiting"],
    refetchInterval: WAITING_POLL_MS,
    enabled: mayDecideProfile,
    queryFn: async () =>
      (await api.get<{ rows: ProfileChange[] }>("/profile-changes?state=PENDING")).data.rows,
  });

  const decideChange = useMutation({
    mutationFn: (what: { id: string; how: "approve" | "reject" }) =>
      api.post(`/profile-changes/${what.id}/${what.how}`, {}),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["profile-changes"] }),
  });

  const advances = useQuery({
    queryKey: ["advances", "waiting"],
    refetchInterval: WAITING_POLL_MS,
    enabled: mayDecideAdvances,
    queryFn: async () =>
      (await api.get<{ rows: WaitingAdvance[] }>("/advances?state=PENDING")).data.rows,
  });

  // Approving does not move money; a second pair of hands records that it left
  // and payroll deducts it from there (KEHOACH 9.6).
  const toPay = useQuery({
    queryKey: ["advances", "approved"],
    refetchInterval: WAITING_POLL_MS,
    enabled: mayPayAdvances,
    queryFn: async () =>
      (await api.get<{ rows: WaitingAdvance[] }>("/advances?state=APPROVED")).data.rows,
  });

  const markPaid = useMutation({
    mutationFn: (id: string) => api.post(`/advances/${id}/paid`, {}),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["advances"] }),
  });

  const decideAdvance = useMutation({
    mutationFn: (what: { id: string; approve: boolean }) =>
      api.post(`/advances/${what.id}/decide`, { approve: what.approve }),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["advances"] }),
  });

  const waiting =
    (inbox.data?.rows.length ?? 0) +
    (waitingDisputes.data?.length ?? 0) +
    (letters.data?.length ?? 0) +
    (changes.data?.length ?? 0) +
    (advances.data?.length ?? 0) +
    (toPay.data?.length ?? 0) +
    (dependents.data?.length ?? 0);

  if (inbox.isError) {
    return <Failed onRetry={() => void inbox.refetch()} />;
  }

  return (
    <section className="w-full">
      <h1 className="text-lg font-semibold">{t("inbox")}</h1>
      <p className="mt-1 text-sm text-(--color-muted)">
        {inbox.isPending ? common("loading") : t("waiting", { count: waiting })}
      </p>

      {!inbox.isPending && waiting === 0 ? (
        <div className="mt-8">
          <p className="text-sm text-(--color-muted)">{t("nothingWaiting")}</p>
          <Link href="/leave" className="mt-2 inline-block text-sm text-(--color-accent) hover:underline">
            {t("nothingWaitingGo")}
          </Link>
        </div>
      ) : null}

      <Queue title={t("title")} count={inbox.data?.rows.length ?? 0}>
        <div className="flex flex-col gap-3">
          {(inbox.data?.rows ?? []).map((row) => (
            <RequestCard
              key={row.id}
              row={row}
              busy={decide.isPending}
              onDecide={(approve, note) => decide.mutate({ id: row.id, approve, note })}
            />
          ))}
        </div>
      </Queue>

      <Queue title={d("inboxTitle")} count={waitingDisputes.data?.length ?? 0}>
        <ul className="flex flex-col gap-2">
          {(waitingDisputes.data ?? []).map((one) => (
            <DisputeCard
              key={one.id}
              dispute={one}
              mayAnswer
              busy={answer.isPending}
              onAnswer={(verdict) => answer.mutate(verdict)}
            />
          ))}
        </ul>
      </Queue>

      <Queue title={c("title")} count={letters.data?.length ?? 0}>
        <Rows>
          {(letters.data ?? []).map((one) => (
            <Row
              key={one.id}
              lead={`${one.employee ? `${one.employee.fullName} · ` : ""}${c(one.kind)}`}
              aside={<span className="text-(--color-muted)">{one.purpose}</span>}
            >
              <Button
                type="button"
                size="sm"
                disabled={decideLetter.isPending}
                onClick={() => decideLetter.mutate({ id: one.id, how: "issue" })}
              >
                {c("issue")}
              </Button>
              <Button
                type="button"
                tone="quiet"
                size="sm"
                disabled={decideLetter.isPending}
                onClick={() => decideLetter.mutate({ id: one.id, how: "reject" })}
              >
                {c("reject")}
              </Button>
            </Row>
          ))}
        </Rows>
      </Queue>

      <Queue title={p("title")} count={changes.data?.length ?? 0}>
        <Rows>
          {(changes.data ?? []).map((one) => (
            <Row
              key={one.id}
              lead={`${one.employee ? `${one.employee.fullName} · ` : ""}${p(`field${one.field}`)}`}
              aside={
                <span className="text-(--color-muted)">
                  {reads(one.oldValue, p("blank"))} → {reads(one.newValue, p("blank"))}
                </span>
              }
            >
              <Button
                type="button"
                size="sm"
                disabled={decideChange.isPending}
                onClick={() => decideChange.mutate({ id: one.id, how: "approve" })}
              >
                {p("approve")}
              </Button>
              <Button
                type="button"
                tone="quiet"
                size="sm"
                disabled={decideChange.isPending}
                onClick={() => decideChange.mutate({ id: one.id, how: "reject" })}
              >
                {p("reject")}
              </Button>
            </Row>
          ))}
        </Rows>
      </Queue>

      <Queue title={pay("advances")} count={advances.data?.length ?? 0}>
        <Rows>
          {(advances.data ?? []).map((one) => (
            <Row
              key={one.id}
              lead={`${one.employee ? `${one.employee.fullName} · ` : ""}${one.reason}`}
              aside={<span className="font-medium tabular-nums">{money(Number(one.amount), locale)}</span>}
            >
              <Button
                type="button"
                size="sm"
                disabled={decideAdvance.isPending}
                onClick={() => decideAdvance.mutate({ id: one.id, approve: true })}
              >
                {t("approve")}
              </Button>
              <Button
                type="button"
                tone="quiet"
                size="sm"
                disabled={decideAdvance.isPending}
                onClick={() => decideAdvance.mutate({ id: one.id, approve: false })}
              >
                {t("reject")}
              </Button>
            </Row>
          ))}
        </Rows>
      </Queue>

      <Queue title={pay("advanceToPay")} count={toPay.data?.length ?? 0}>
        <Rows>
          {(toPay.data ?? []).map((one) => (
            <Row
              key={one.id}
              lead={`${one.employee ? `${one.employee.fullName} · ` : ""}${one.reason}`}
              aside={<span className="font-medium tabular-nums">{money(Number(one.amount), locale)}</span>}
            >
              <Button
                type="button"
                size="sm"
                disabled={markPaid.isPending}
                onClick={() => markPaid.mutate(one.id)}
              >
                {pay("advancePay")}
              </Button>
            </Row>
          ))}
        </Rows>
      </Queue>

      <Queue title={me("dependentsTitle")} count={dependents.data?.length ?? 0}>
        <Rows>
          {(dependents.data ?? []).map((one) => (
            <Row
              key={one.id}
              lead={`${one.employee.fullName} · ${one.fullName}`}
              aside={
                <span className="text-(--color-muted)">
                  {me(`relation${one.relation}`)} · {format.dateTime(dayOnly(one.fromMonth), "day")}
                </span>
              }
            >
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
            </Row>
          ))}
        </Rows>
      </Queue>
    </section>
  );
}
