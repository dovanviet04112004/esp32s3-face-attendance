"use client";

import { Button, Empty, Input, LayerCard, LinkButton, SkeletonLine, TableOfContents } from "@cloudflare/kumo";
import { CheckIcon, TrayIcon, XIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { DisputeCard, type Dispute, type Verdict } from "@/components/payroll/dispute-card";
import { RequestCard, type RequestRow } from "@/components/requests/request-card";
import {
  ADVANCE_DECIDERS,
  ADVANCE_PAYERS,
  DEPENDENT_DECIDERS,
  DISPUTE_ANSWERERS,
  LETTER_DESK,
  PROFILE_DESK,
  WAITING_POLL_MS,
} from "@/components/nav/waiting-count";
import { PagingRow } from "@/components/tables/data-table";
import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, PageHeader, PageLayout } from "@/components/ui/page";
import { CountPill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { dayOnly, money } from "@/lib/format";

const RELATIONS = ["CHILD", "SPOUSE", "PARENT", "SIBLING", "OTHER"] as const;
const REGISTER_READERS = ["ADMIN", "HR", "MANAGER"];
const kInboxPage = 50;

interface InboxPage {
  rows: RequestRow[];
  total: number;
}

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

interface Decided {
  id: string;
  approve: boolean;
  note: string;
  name: string;
}

function reads(values: Record<string, string | null> | null, blank: string): string {
  const shown = Object.values(values ?? {}).filter((one) => one !== null && one !== "");
  return shown.length > 0 ? shown.join(" · ") : blank;
}

function Queue({ id, title, count, children }: { id: string; title: string; count: number; children: ReactNode }) {
  if (count === 0) {
    return null;
  }
  return (
    <section id={`queue-${id}`} className="flex scroll-mt-24 flex-col gap-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        {title}
        <CountPill>{count}</CountPill>
      </h2>
      {children}
    </section>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return (
    <LayerCard className="p-0">
      <ul className="divide-y divide-kumo-hairline">{children}</ul>
    </LayerCard>
  );
}

interface DecisionProps {
  lead: string;
  detail?: ReactNode;
  aside?: ReactNode;
  approveLabel: string;
  busy: boolean;
  onApprove: () => void;
  /** Turning down always carries a reason the asker can read. */
  onReject?: (reason: string) => void;
}

// Stacked on a phone so the buttons keep a whole line; wrapping them mid-row put a decision under a name.
function Decision({ lead, detail, aside, approveLabel, busy, onApprove, onReject }: DecisionProps) {
  const t = useTranslations("requests");
  const common = useTranslations("common");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [pressed, setPressed] = useState<"approve" | "reject" | null>(null);

  return (
    <li className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{lead}</p>
          {detail ? <p className="text-sm break-words text-kumo-subtle">{detail}</p> : null}
        </div>
        {aside ? <span className="shrink-0 font-medium tabular-nums">{aside}</span> : null}
        {rejecting ? null : (
          <div className="flex shrink-0 gap-2">
            <Button
              variant="secondary"
              icon={CheckIcon}
              loading={busy && pressed === "approve"}
              disabled={busy}
              onClick={() => {
                setPressed("approve");
                onApprove();
              }}
            >
              {approveLabel}
            </Button>
            {onReject ? (
              <Button variant="secondary-destructive" icon={XIcon} disabled={busy} onClick={() => setRejecting(true)}>
                {t("reject")}
              </Button>
            ) : null}
          </div>
        )}
      </div>
      {rejecting && onReject ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <Input
              label={t("rejectReason")}
              autoFocus
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary-destructive"
              icon={XIcon}
              loading={busy && pressed === "reject"}
              disabled={busy || reason.trim() === ""}
              onClick={() => {
                setPressed("reject");
                onReject(reason.trim());
              }}
            >
              {t("rejectSend")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setRejecting(false)}>
              {common("cancel")}
            </Button>
          </div>
        </div>
      ) : null}
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
  const locale = useLocale();
  const cache = useQueryClient();
  const notify = useNotify();
  const role = useSession((s) => s.role);
  const mayDecideDependents = role !== null && DEPENDENT_DECIDERS.includes(role);
  const mayAnswerDisputes = role !== null && DISPUTE_ANSWERERS.includes(role);
  const mayIssueLetters = role !== null && LETTER_DESK.includes(role);
  const mayDecideProfile = role !== null && PROFILE_DESK.includes(role);
  const mayDecideAdvances = role !== null && ADVANCE_DECIDERS.includes(role);
  const mayPayAdvances = role !== null && ADVANCE_PAYERS.includes(role);
  const [focused, setFocused] = useState<string | null>(null);

  const inbox = useInfiniteQuery({
    queryKey: ["requests", "inbox"],
    refetchInterval: WAITING_POLL_MS,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      (await api.get<InboxPage>(`/requests/inbox?skip=${pageParam}&take=${kInboxPage}`)).data,
    getNextPageParam: (last, pages) => {
      const seen = pages.reduce((total, one) => total + one.rows.length, 0);
      return seen < last.total ? seen : undefined;
    },
  });

  function decided(what: Decided): void {
    notify.done(what.approve ? t("approvedOf", { name: what.name }) : t("rejectedOf", { name: what.name }));
  }

  const decide = useMutation({
    mutationFn: (what: Decided) =>
      api.post(`/requests/${what.id}/decide`, { approve: what.approve, note: what.note || undefined }),
    onSuccess: (_, what) => {
      decided(what);
      void cache.invalidateQueries({ queryKey: ["requests"] });
      void cache.invalidateQueries({ queryKey: ["leave-balances"] });
    },
    onError: notify.failed,
  });

  const dependents = useQuery({
    queryKey: ["dependents", "waiting"],
    refetchInterval: WAITING_POLL_MS,
    enabled: mayDecideDependents,
    queryFn: async () => (await api.get<{ rows: WaitingDependent[] }>("/dependents?state=PENDING")).data.rows,
  });

  const decideDependent = useMutation({
    mutationFn: (what: Decided) =>
      api.post(`/dependents/${what.id}/decide`, { approve: what.approve, note: what.note || undefined }),
    onSuccess: (_, what) => {
      decided(what);
      void cache.invalidateQueries({ queryKey: ["dependents"] });
    },
    onError: notify.failed,
  });

  const waitingDisputes = useQuery({
    queryKey: ["payslip-disputes", "waiting"],
    refetchInterval: WAITING_POLL_MS,
    enabled: mayAnswerDisputes,
    queryFn: async () => (await api.get<{ rows: Dispute[] }>("/payslip-disputes?state=OPEN")).data.rows,
  });

  const answer = useMutation({
    mutationFn: (verdict: Verdict) =>
      api.post(`/payslip-disputes/${verdict.id}/answer`, {
        outcome: verdict.outcome,
        answer: verdict.answer,
        ...(verdict.amount === undefined ? {} : { amount: verdict.amount }),
      }),
    onSuccess: () => {
      notify.done(t("answeredDone"));
      void cache.invalidateQueries({ queryKey: ["payslip-disputes"] });
    },
    onError: notify.failed,
  });

  const letters = useQuery({
    queryKey: ["certificates", "waiting"],
    refetchInterval: WAITING_POLL_MS,
    enabled: mayIssueLetters,
    queryFn: async () => (await api.get<{ rows: Letter[] }>("/certificates?state=REQUESTED")).data.rows,
  });

  const decideLetter = useMutation({
    mutationFn: async (what: Decided) => {
      await api.post(`/certificates/${what.id}/${what.approve ? "issue" : "reject"}`, what.approve ? {} : { note: what.note });
    },
    onSuccess: (_, what) => {
      notify.done(what.approve ? t("issuedTo", { name: what.name }) : t("rejectedOf", { name: what.name }));
      void cache.invalidateQueries({ queryKey: ["certificates"] });
    },
    onError: notify.failed,
  });

  const changes = useQuery({
    queryKey: ["profile-changes", "waiting"],
    refetchInterval: WAITING_POLL_MS,
    enabled: mayDecideProfile,
    queryFn: async () => (await api.get<{ rows: ProfileChange[] }>("/profile-changes?state=PENDING")).data.rows,
  });

  const decideChange = useMutation({
    mutationFn: async (what: Decided) => {
      await api.post(`/profile-changes/${what.id}/${what.approve ? "approve" : "reject"}`, what.approve ? {} : { note: what.note });
    },
    onSuccess: (_, what) => {
      decided(what);
      void cache.invalidateQueries({ queryKey: ["profile-changes"] });
    },
    onError: notify.failed,
  });

  const advances = useQuery({
    queryKey: ["advances", "waiting"],
    refetchInterval: WAITING_POLL_MS,
    enabled: mayDecideAdvances,
    queryFn: async () => (await api.get<{ rows: WaitingAdvance[] }>("/advances?state=PENDING")).data.rows,
  });

  // Approving does not move money; a second pair of hands records that it left
  // and payroll deducts it from there (KEHOACH 9.6).
  const toPay = useQuery({
    queryKey: ["advances", "approved"],
    refetchInterval: WAITING_POLL_MS,
    enabled: mayPayAdvances,
    queryFn: async () => (await api.get<{ rows: WaitingAdvance[] }>("/advances?state=APPROVED")).data.rows,
  });

  const markPaid = useMutation({
    mutationFn: (what: { id: string; name: string }) => api.post(`/advances/${what.id}/paid`, {}),
    onSuccess: (_, what) => {
      notify.done(t("paidTo", { name: what.name }));
      void cache.invalidateQueries({ queryKey: ["advances"] });
    },
    onError: notify.failed,
  });

  const decideAdvance = useMutation({
    mutationFn: (what: Decided) =>
      api.post(`/advances/${what.id}/decide`, { approve: what.approve, note: what.note || undefined }),
    onSuccess: (_, what) => {
      decided(what);
      void cache.invalidateQueries({ queryKey: ["advances"] });
    },
    onError: notify.failed,
  });

  const requests = inbox.data?.pages.flatMap((one) => one.rows) ?? [];
  const requestTotal = inbox.data?.pages[0]?.total ?? 0;
  const queues = [
    { id: "requests", title: t("title"), count: requestTotal },
    { id: "disputes", title: d("inboxTitle"), count: waitingDisputes.data?.length ?? 0 },
    { id: "letters", title: c("title"), count: letters.data?.length ?? 0 },
    { id: "changes", title: p("title"), count: changes.data?.length ?? 0 },
    { id: "advances", title: pay("advances"), count: advances.data?.length ?? 0 },
    { id: "toPay", title: pay("advanceToPay"), count: toPay.data?.length ?? 0 },
    { id: "dependents", title: me("dependentsTitle"), count: dependents.data?.length ?? 0 },
  ];
  const waitingQueues = queues.filter((one) => one.count > 0);
  const waiting = queues.reduce((total, one) => total + one.count, 0);
  const asked = [inbox, dependents, waitingDisputes, letters, changes, advances, toPay];
  const loading = asked.some((one) => one.isLoading);
  const broken = asked.filter((one) => one.isError);
  const titleOf = (id: string) => queues.find((one) => one.id === id)?.title ?? "";
  const someone = (employee?: { fullName: string }) => employee?.fullName ?? "none";

  function go(id: string): void {
    setFocused(id);
    document.getElementById(`queue-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <>
      <PageHeader
        title={t("approvalsTitle")}
        description={t("approvalsLead")}
        meta={waiting > 0 ? <CountPill>{waiting}</CountPill> : undefined}
      />

      <PageLayout
        aside={
          waitingQueues.length > 0 ? (
            <AsideCard title={t("queues")}>
              <TableOfContents>
                <TableOfContents.List>
                  {waitingQueues.map((one) => (
                    <TableOfContents.Item
                      key={one.id}
                      render={<button type="button" />}
                      active={(focused ?? waitingQueues[0]?.id) === one.id}
                      onClick={() => go(one.id)}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate">{one.title}</span>
                        <CountPill>{one.count}</CountPill>
                      </span>
                    </TableOfContents.Item>
                  ))}
                </TableOfContents.List>
              </TableOfContents>
            </AsideCard>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-8">
          {broken.length > 0 ? <Failed onRetry={() => broken.forEach((one) => void one.refetch())} /> : null}

          {loading && waiting === 0 ? (
            <LayerCard className="flex flex-col gap-3 p-4">
              {Array.from({ length: 4 }, (_, at) => (
                <SkeletonLine key={at} minWidth={27} maxWidth={70} />
              ))}
            </LayerCard>
          ) : null}

          {!loading && broken.length === 0 && waiting === 0 ? (
            <LayerCard className="p-0">
              <Empty
                icon={<TrayIcon size={40} className="text-kumo-inactive" />}
                title={t("nothingWaiting")}
                description={t("nothingWaitingHint")}
                contents={
                  role !== null && REGISTER_READERS.includes(role) ? (
                    <LinkButton href="/leave" variant="secondary">
                      {t("nothingWaitingGo")}
                    </LinkButton>
                  ) : undefined
                }
                className="py-12"
              />
            </LayerCard>
          ) : null}

          <Queue id="requests" title={titleOf("requests")} count={requestTotal}>
            {requests.map((row) => (
              <RequestCard
                key={row.id}
                row={row}
                balance
                busy={decide.isPending && decide.variables?.id === row.id}
                onDecide={(approve, note) => decide.mutate({ id: row.id, approve, note, name: someone(row.employee ?? undefined) })}
              />
            ))}
            {requests.length < requestTotal ? (
              <LayerCard className="p-0">
                <PagingRow
                  paging={{
                    shown: requests.length,
                    total: requestTotal,
                    onMore: inbox.hasNextPage ? () => void inbox.fetchNextPage() : undefined,
                    loading: inbox.isFetchingNextPage,
                  }}
                />
              </LayerCard>
            ) : null}
          </Queue>

          <Queue id="disputes" title={titleOf("disputes")} count={waitingDisputes.data?.length ?? 0}>
            <ul className="flex flex-col gap-2">
              {(waitingDisputes.data ?? []).map((one) => (
                <DisputeCard
                  key={one.id}
                  dispute={one}
                  mayAnswer
                  busy={answer.isPending && answer.variables?.id === one.id}
                  onAnswer={(verdict) => answer.mutate(verdict)}
                />
              ))}
            </ul>
          </Queue>

          <Queue id="letters" title={titleOf("letters")} count={letters.data?.length ?? 0}>
            <Rows>
              {(letters.data ?? []).map((one) => (
                <Decision
                  key={one.id}
                  lead={`${one.employee ? `${one.employee.fullName} · ` : ""}${c(one.kind)}`}
                  detail={one.purpose}
                  approveLabel={c("issue")}
                  busy={decideLetter.isPending && decideLetter.variables?.id === one.id}
                  onApprove={() => decideLetter.mutate({ id: one.id, approve: true, note: "", name: someone(one.employee) })}
                  onReject={(note) => decideLetter.mutate({ id: one.id, approve: false, note, name: someone(one.employee) })}
                />
              ))}
            </Rows>
          </Queue>

          <Queue id="changes" title={titleOf("changes")} count={changes.data?.length ?? 0}>
            <Rows>
              {(changes.data ?? []).map((one) => (
                <Decision
                  key={one.id}
                  lead={`${one.employee ? `${one.employee.fullName} · ` : ""}${p(`field${one.field}`)}`}
                  detail={`${reads(one.oldValue, p("blank"))} → ${reads(one.newValue, p("blank"))}`}
                  approveLabel={p("approve")}
                  busy={decideChange.isPending && decideChange.variables?.id === one.id}
                  onApprove={() => decideChange.mutate({ id: one.id, approve: true, note: "", name: someone(one.employee) })}
                  onReject={(note) => decideChange.mutate({ id: one.id, approve: false, note, name: someone(one.employee) })}
                />
              ))}
            </Rows>
          </Queue>

          <Queue id="advances" title={titleOf("advances")} count={advances.data?.length ?? 0}>
            <Rows>
              {(advances.data ?? []).map((one) => (
                <Decision
                  key={one.id}
                  lead={one.employee?.fullName ?? pay("advances")}
                  detail={one.reason}
                  aside={money(Number(one.amount), locale)}
                  approveLabel={t("approve")}
                  busy={decideAdvance.isPending && decideAdvance.variables?.id === one.id}
                  onApprove={() => decideAdvance.mutate({ id: one.id, approve: true, note: "", name: someone(one.employee) })}
                  onReject={(note) => decideAdvance.mutate({ id: one.id, approve: false, note, name: someone(one.employee) })}
                />
              ))}
            </Rows>
          </Queue>

          <Queue id="toPay" title={titleOf("toPay")} count={toPay.data?.length ?? 0}>
            <Rows>
              {(toPay.data ?? []).map((one) => (
                <Decision
                  key={one.id}
                  lead={one.employee?.fullName ?? pay("advanceToPay")}
                  detail={one.reason}
                  aside={money(Number(one.amount), locale)}
                  approveLabel={pay("advancePay")}
                  busy={markPaid.isPending && markPaid.variables?.id === one.id}
                  onApprove={() => markPaid.mutate({ id: one.id, name: someone(one.employee) })}
                />
              ))}
            </Rows>
          </Queue>

          <Queue id="dependents" title={titleOf("dependents")} count={dependents.data?.length ?? 0}>
            <Rows>
              {(dependents.data ?? []).map((one) => (
                <Decision
                  key={one.id}
                  lead={`${one.employee.fullName} · ${one.fullName}`}
                  detail={`${me(`relation${one.relation}`)} · ${format.dateTime(dayOnly(one.fromMonth), "day")}`}
                  approveLabel={t("approve")}
                  busy={decideDependent.isPending && decideDependent.variables?.id === one.id}
                  onApprove={() => decideDependent.mutate({ id: one.id, approve: true, note: "", name: one.employee.fullName })}
                  onReject={(note) => decideDependent.mutate({ id: one.id, approve: false, note, name: one.employee.fullName })}
                />
              ))}
            </Rows>
          </Queue>
        </div>
      </PageLayout>
    </>
  );
}
