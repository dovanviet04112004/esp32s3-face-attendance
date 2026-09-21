"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { Failed } from "@/components/ui/empty";
import { DisputeCard, type Dispute, type Verdict } from "@/components/payroll/dispute-card";
import { RequestCard, type RequestRow } from "@/components/requests/request-card";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { money } from "@/lib/format";

const DEPENDENT_DECIDERS = ["ADMIN", "PAYROLL"];
const ADVANCE_DECIDERS = ["ADMIN", "PAYROLL", "HR", "MANAGER"];
const DISPUTE_ANSWERERS = ["ADMIN", "PAYROLL"];
const LETTER_DESK = ["ADMIN", "HR", "PAYROLL"];
const PROFILE_DESK = ["ADMIN", "HR"];
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
        <span className="rounded-full bg-(--color-ground) px-2 py-0.5 text-xs tabular-nums text-(--color-muted)">
          {count}
        </span>
      </h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

export default function ApprovalsPage() {
  const t = useTranslations("requests");
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

  const letters = useQuery({
    queryKey: ["certificates", "waiting"],
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
    enabled: mayDecideAdvances,
    queryFn: async () => (await api.get<WaitingAdvance[]>("/advances?state=PENDING")).data,
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
    (dependents.data?.length ?? 0);

  if (inbox.isError) {
    return <Failed onRetry={() => void inbox.refetch()} />;
  }

  return (
    <section className="mx-auto w-full max-w-(--width-read)">
      <h1 className="text-lg font-semibold">{t("inbox")}</h1>
      <p className="mt-1 text-sm text-(--color-muted)">
        {inbox.isPending ? common("loading") : t("waiting", { count: waiting })}
      </p>

      {!inbox.isPending && waiting === 0 ? (
        <p className="mt-8 text-sm text-(--color-muted)">{t("nothingWaiting")}</p>
      ) : null}

      <Queue title={t("inbox")} count={inbox.data?.rows.length ?? 0}>
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
        <ul className="divide-y divide-(--color-line) rounded-xl border border-(--color-line) bg-(--color-surface)">
          {(letters.data ?? []).map((one) => (
            <li key={one.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <span className="min-w-0 flex-1">
                {one.employee ? `${one.employee.fullName} · ` : ""}
                {c(one.kind)}
              </span>
              <span className="text-(--color-muted)">{one.purpose}</span>
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
            </li>
          ))}
        </ul>
      </Queue>

      <Queue title={p("title")} count={changes.data?.length ?? 0}>
        <ul className="divide-y divide-(--color-line) rounded-xl border border-(--color-line) bg-(--color-surface)">
          {(changes.data ?? []).map((one) => (
            <li key={one.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <span className="min-w-0 flex-1">
                {one.employee ? `${one.employee.fullName} · ` : ""}
                {p(`field${one.field}`)}
              </span>
              <span className="text-(--color-muted)">
                {reads(one.oldValue, p("blank"))} → {reads(one.newValue, p("blank"))}
              </span>
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
            </li>
          ))}
        </ul>
      </Queue>

      <Queue title={pay("advances")} count={advances.data?.length ?? 0}>
        <ul className="divide-y divide-(--color-line) rounded-xl border border-(--color-line) bg-(--color-surface)">
          {(advances.data ?? []).map((one) => (
            <li key={one.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {one.employee ? `${one.employee.fullName} · ` : ""}
                {one.reason}
              </span>
              <span className="tabular-nums">{money(Number(one.amount), locale)}</span>
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
            </li>
          ))}
        </ul>
      </Queue>

      <Queue title={me("dependentsTitle")} count={dependents.data?.length ?? 0}>
        <ul className="divide-y divide-(--color-line) rounded-xl border border-(--color-line) bg-(--color-surface)">
          {(dependents.data ?? []).map((one) => (
            <li key={one.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {one.employee.fullName} · {one.fullName}
              </span>
              <span className="text-(--color-muted)">{me(`relation${one.relation}`)}</span>
              <span className="tabular-nums text-(--color-muted)">{one.fromMonth.slice(0, 10)}</span>
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
      </Queue>
    </section>
  );
}
