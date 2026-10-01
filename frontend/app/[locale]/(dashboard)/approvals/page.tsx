"use client";

import { Button, Input, LayerDialog, Textarea } from "@cloudflare/kumo";
import { CheckIcon, XIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";

import { COUNTS_KEY, QUEUE_ROLES, WAITING_POLL_MS, useInboxCounts, type Queue } from "@/components/nav/waiting-count";
import { useLineName } from "@/components/payroll/payslip-view";
import {
  DecisionFields,
  RequestFacts,
  useDecision,
  leftByYear,
  useRequestWords,
  type InboxRow,
  type RequestDetail,
  type RequestKind,
  type RequestRow,
} from "@/components/requests/request-card";
import { REQUEST_KINDS } from "@/components/requests/request-form";
import { DataTable, PersonCell, type Column, type Paging } from "@/components/tables/data-table";
import { FilterBar, useSettled, type Filter } from "@/components/ui/filter-bar";
import { useNotify } from "@/components/ui/notify";
import { useOptional } from "@/components/ui/optional";
import { Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { CountPill, StatePill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { dayOnly, days, money } from "@/lib/format";
import { useUrlState } from "@/lib/url-state";

const kPage = 50;
const kDayMs = 86_400_000;
const LETTER_KINDS = ["EMPLOYMENT", "INCOME"] as const;
const PROFILE_FIELDS = ["PERSONAL_EMAIL", "PHONE", "BANK", "NATIONAL_ID", "TAX_CODE", "SOCIAL_INSURANCE_NO"] as const;
const QUEUE_ORDER: Queue[] = [
  "requests",
  "disputes",
  "certificates",
  "profileChanges",
  "dependents",
  "advancesToDecide",
  "advancesToPay",
];
const DEFAULTS = { tab: "", q: "", kind: "", dept: "", from: "", to: "", order: "", open: "" };

type UrlState = typeof DEFAULTS;

interface Page<T> {
  rows: T[];
  total: number;
  totalIsExact?: boolean;
  next?: string | null;
}

interface Who {
  id: number;
  code: string;
  fullName: string;
  department?: { id: string; name: string } | null;
}

interface Decision {
  decidedByName?: string | null;
}

interface Letter extends Decision {
  id: string;
  kind: (typeof LETTER_KINDS)[number];
  purpose: string;
  months: number | null;
  createdAt: string;
  waitedDays: number;
  employee: Who;
  state?: "REQUESTED" | "ISSUED" | "REJECTED" | "CANCELLED";
  issuedAt?: string | null;
  updatedAt?: string;
  note?: string | null;
}

interface Change extends Decision {
  id: string;
  field: (typeof PROFILE_FIELDS)[number];
  oldValue: Record<string, string | null> | null;
  newValue: Record<string, string | null>;
  reason: string | null;
  createdAt: string;
  waitedDays: number;
  employee: Who;
  state?: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  decidedAt?: string | null;
  note?: string | null;
}

interface Claim extends Decision {
  id: string;
  payslipId: string;
  lineCode: string | null;
  claim: string;
  dueAt: string;
  createdAt: string;
  waitedDays: number;
  employee: Who;
  payslip: { period: { year: number; month: number } };
  state?: "OPEN" | "ANSWERED" | "WITHDRAWN";
  outcome?: "UPHELD" | "REJECTED" | null;
  answer?: string | null;
  answeredAt?: string | null;
}

interface Advance extends Decision {
  id: string;
  amount: string;
  reason: string;
  requestedAt: string;
  decidedAt: string | null;
  waitedDays: number;
  baseSalary: string | null;
  outstanding: string | null;
  employee: Who;
  state?: "PENDING" | "APPROVED" | "REJECTED" | "PAID" | "SETTLED" | "CANCELLED";
  decisionNote?: string | null;
  paidAt?: string | null;
}

interface Dependent extends Decision {
  id: string;
  fullName: string;
  relation: "CHILD" | "SPOUSE" | "PARENT" | "SIBLING" | "OTHER";
  fromMonth: string;
  createdAt: string;
  employee: Who;
  state?: "PENDING" | "ACTIVE" | "REJECTED" | "ENDED";
  decidedAt?: string | null;
  decisionNote?: string | null;
}

interface Verdict {
  id: string;
  approve: boolean;
  note: string;
  name: string;
}

interface Department {
  id: string;
  name: string;
}

function query(params: Record<string, string>): string {
  return new URLSearchParams(Object.entries(params).filter(([, value]) => value !== "")).toString();
}

function waitedSince(row: { createdAt: string; waitedDays?: number }): number {
  return row.waitedDays ?? Math.max(0, Math.floor((Date.now() - new Date(row.createdAt).getTime()) / kDayMs));
}

function flat<T>(data: InfiniteData<Page<T>> | undefined): { rows: T[] | undefined; total: number; exact: boolean } {
  return {
    rows: data?.pages.flatMap((one) => one.rows),
    total: data?.pages[0]?.total ?? 0,
    exact: data?.pages[0]?.totalIsExact !== false,
  };
}

/** One queue, cursor-paged, polled as a net under the live feed (KEHOACH 9.4). */
function useQueue<T>(key: string[], path: string, params: Record<string, string>) {
  return useInfiniteQuery({
    queryKey: [...key, params],
    refetchInterval: WAITING_POLL_MS,
    initialPageParam: "",
    queryFn: async ({ pageParam }) =>
      (await api.get<Page<T>>(`${path}?${query({ ...params, take: String(kPage), cursor: pageParam })}`)).data,
    getNextPageParam: (last) => last.next ?? undefined,
  });
}

function usePaging<T>(asked: ReturnType<typeof useQueue<T>>): { rows: T[] | undefined; paging: Paging | undefined } {
  const { rows, total, exact } = flat(asked.data);
  return {
    rows,
    paging: asked.data
      ? {
          shown: rows?.length ?? 0,
          total,
          exact,
          onMore: asked.hasNextPage ? () => void asked.fetchNextPage() : undefined,
          loading: asked.isFetchingNextPage,
        }
      : undefined,
  };
}

interface Linked {
  /** The item a notice opened this page for, from `?open=`; empty when none. */
  openId: string;
  /** Takes `open` off the address once the item is shown, so a reload does not reopen it. */
  onOpened: () => void;
}

/** Opens the item a notice points at: from the queue page in view, or by its own record once it has left
 *  the queue, so a decided item still opens on what it came to (KEHOACH 9.21.4).
 */
function useLinkedRow<T extends { id: string }>(
  { openId, onOpened }: Linked,
  asked: ReturnType<typeof useQueue<T>>,
  show: (row: T) => void,
  path: string,
  matches: (row: T, id: string) => boolean = (row, id) => row.id === id,
): void {
  const notify = useNotify();
  const loaded = asked.data !== undefined;
  useEffect(() => {
    if (openId === "" || !loaded) {
      return;
    }
    onOpened();
    const found = asked.data?.pages.flatMap((one) => one.rows).find((row) => matches(row, openId));
    if (found) {
      show(found);
      return;
    }
    api.get<T>(`${path}/${openId}`).then((held) => show(held.data), notify.failed);
  }, [openId, loaded]); // eslint-disable-line react-hooks/exhaustive-deps
}

type HandledKey = "handledAPPROVED" | "handledREJECTED" | "handledISSUED" | "handledUPHELD" | "handledPAID" | "handledWithdrawn";

interface Said {
  key: HandledKey;
  who?: string | null;
  at?: string | null;
  note?: string | null;
}

/** What a handled item came to, in place of its decision; a 409 lands here too (KEHOACH 9.21.4). */
function useHandled(): (said: Said | null) => ReactNode {
  const t = useTranslations("requests");
  const format = useFormatter();
  return (said) =>
    said ? (
      <div className="mt-4 flex flex-col gap-2 border-t border-kumo-hairline pt-4">
        <p className="font-medium">
          {t(said.key, { who: said.who ?? t("handledSomeone"), time: said.at ? format.dateTime(new Date(said.at), "medium") : "—" })}
        </p>
        {said.note ? <p className="rounded-lg bg-kumo-tint p-3 break-words">{said.note}</p> : null}
      </div>
    ) : undefined;
}

/** An inbox row for a request opened by its id, when the inbox page in view does not hold it. */
function asInboxRow(detail: RequestDetail): InboxRow {
  return {
    ...detail,
    waitedDays: waitedSince(detail),
    balanceAfter: detail.balance?.remaining ?? null,
    nextBalanceAfter: detail.nextBalance?.remaining ?? null,
    overlapCount: detail.kind === "LEAVE" ? detail.overlapping.length : null,
  };
}

/** What a decided or withdrawn request came to, shown in place of the decision (KEHOACH 9.21.4). */
function Handled({ row }: { row: RequestRow }) {
  const t = useTranslations("requests");
  const format = useFormatter();
  const who = row.decidedBy?.fullName ?? row.decidedBy?.email ?? "";
  const time = row.decidedAt ? format.dateTime(new Date(row.decidedAt), "medium") : "";
  const said =
    row.state === "APPROVED" || row.state === "REJECTED" ? t(`handled${row.state}`, { who, time }) : t("handledCANCELLED");
  return (
    <div className="mt-4 flex flex-col gap-2 border-t border-kumo-hairline pt-4">
      <p className="font-medium">{said}</p>
      {row.decisionNote ? <p className="rounded-lg bg-kumo-tint p-3 break-words">{row.decisionNote}</p> : null}
    </div>
  );
}

function Waited({ count }: { count: number }) {
  const t = useTranslations("requests");
  return <span className="whitespace-nowrap tabular-nums">{t("waitedDays", { count })}</span>;
}

/** What each year keeps once a leave is granted; an unpaid type spends no balance (KEHOACH 9.5). */
function useBalanceFacts(): (row: InboxRow) => [string, ReactNode][] {
  const t = useTranslations("requests");
  const locale = useLocale();
  return (row) => {
    if (row.kind !== "LEAVE") {
      return [];
    }
    if (row.leaveType?.paid === false) {
      return [[t("balanceAfter"), t("noBalance")]];
    }
    const split = leftByYear(row);
    if (split) {
      return split.map((one) => [t("balanceAfterIn", { year: one.year }), days(one.left, locale)]);
    }
    return row.balanceAfter === null ? [] : [[t("balanceAfter"), days(row.balanceAfter, locale)]];
  };
}

function BalanceAfter({ row }: { row: InboxRow }) {
  const common = useTranslations("common");
  const t = useTranslations("requests");
  const locale = useLocale();
  if (row.leaveType?.paid === false) {
    return <span className="text-kumo-subtle">{t("noBalance")}</span>;
  }
  const split = leftByYear(row);
  if (split) {
    return (
      <span className="flex flex-col whitespace-nowrap">
        {split.map((one) => (
          <span key={one.year}>{t("yearDays", { year: one.year, days: days(one.left, locale) })}</span>
        ))}
      </span>
    );
  }
  return <>{row.balanceAfter === null ? common("empty") : days(row.balanceAfter, locale)}</>;
}

function personColumns<T extends { employee: Who | null }>(who: string, department: string, empty: string): Column<T>[] {
  return [
    { id: "person", header: who, cell: (row) => <PersonCell name={row.employee?.fullName ?? empty} code={row.employee?.code} /> },
    {
      id: "department",
      header: department,
      priority: 2,
      truncate: true,
      maxWidthPx: 200,
      cell: (row) => row.employee?.department?.name ?? empty,
    },
  ];
}

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  person: Who | null;
  title: string;
  children: ReactNode;
  approveLabel: string;
  busy: boolean;
  fault: string | null;
  onApprove: (note: string) => void;
  onReject?: (reason: string) => void;
  noteOnApprove?: boolean;
  /** Read-only outcome shown in place of the decision once somebody has handled the item. */
  handled?: ReactNode;
}

/** The context to decide one item, and the decision at the bottom of the sheet (KEHOACH 9.10). */
function DecisionSheet({ open, onOpenChange, person, title, children, approveLabel, busy, fault, onApprove, onReject, noteOnApprove, handled }: SheetProps) {
  const t = useTranslations("requests");
  const common = useTranslations("common");
  const decision = useDecision();
  return (
    <LayerDialog.Root open={open} onOpenChange={onOpenChange} dismissDisabled={busy}>
      <LayerDialog.Content size="lg" closeLabel={common("close")}>
        <LayerDialog.Title>{person ? person.fullName : title}</LayerDialog.Title>
        <LayerDialog.Description>
          {person ? [person.code, person.department?.name, title].filter(Boolean).join(" · ") : title}
        </LayerDialog.Description>
        <LayerDialog.Body>
          {children}
          {handled ?? (
            <DecisionFields decision={decision} fault={fault} noteOnApprove={noteOnApprove} mayReject={onReject !== undefined} busy={busy} />
          )}
        </LayerDialog.Body>
        {handled ? null : (
          <LayerDialog.Actions dismissLabel={common("close")}>
            <LayerDialog.Actions.Primary
              variant={decision.rejecting ? "destructive" : "primary"}
              loading={busy}
              onClick={() => decision.send(onApprove, onReject)}
            >
              {decision.rejecting ? t("rejectSend") : approveLabel}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        )}
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

/** A mutation that closes its sheet on success, keeps the server's answer in it on failure,
 *  and drops what it made stale either way.
 */
function useSheetMutation<V>(
  stale: string,
  done: (value: V) => string,
  send: (value: V) => Promise<unknown>,
  onClose: () => void,
  onConflict?: (value: V) => void,
) {
  const cache = useQueryClient();
  const notify = useNotify();
  const faultOf = useFault();
  const [fault, setFault] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: send,
    onSuccess: (_, value) => {
      notify.done(done(value));
      setFault(null);
      onClose();
      void cache.invalidateQueries({ queryKey: [stale] });
      void cache.invalidateQueries({ queryKey: COUNTS_KEY });
    },
    onError: (fell: unknown, value) => {
      void cache.invalidateQueries({ queryKey: [stale] });
      if (onConflict && isAxiosError(fell) && fell.response?.status === 409) {
        setFault(null);
        onConflict(value);
        return;
      }
      setFault(faultOf(fell));
    },
  });
  return { mutation, fault, clear: () => setFault(null) };
}

interface QueueProps extends Linked {
  params: Record<string, string>;
  filtered: boolean;
}

function RequestsQueue({ params, filtered, openId, onOpened }: QueueProps) {
  const t = useTranslations("requests");
  const common = useTranslations("common");
  const errors = useTranslations("errors");
  const words = useRequestWords();
  const notify = useNotify();
  const faultOf = useFault();
  const cache = useQueryClient();
  const asked = useQueue<InboxRow>(["requests", "inbox"], "/requests/inbox", params);
  const { rows, paging } = usePaging(asked);
  const [open, setOpen] = useState<InboxRow | null>(null);
  const [bulk, setBulk] = useState<{ approve: boolean; ids: string[] } | null>(null);
  const [reason, setReason] = useState("");
  const [bulkFault, setBulkFault] = useState<string | null>(null);
  const balanceFacts = useBalanceFacts();

  const detail = useQuery({
    queryKey: ["requests", "one", open?.id],
    enabled: open !== null,
    queryFn: async () => (await api.get<RequestDetail>(`/requests/${open?.id ?? ""}`)).data,
  });

  // A request opened by its id may sit past the inbox page in view, or have left the inbox already.
  const linked = useQuery({
    queryKey: ["requests", "one", openId],
    enabled: openId !== "",
    queryFn: async () => (await api.get<RequestDetail>(`/requests/${openId}`)).data,
  });
  useEffect(() => {
    if (openId === "" || linked.isPending) {
      return;
    }
    if (linked.data) {
      setOpen(rows?.find((row) => row.id === openId) ?? asInboxRow(linked.data));
    } else {
      notify.failed(linked.error);
    }
    onOpened();
  }, [openId, linked.isPending]); // eslint-disable-line react-hooks/exhaustive-deps

  const handled = detail.data && detail.data.state !== "PENDING" ? detail.data : null;

  const decide = useSheetMutation<Verdict>(
    "requests",
    (value: { approve: boolean; name: string }) =>
      value.approve ? t("approvedOf", { name: value.name }) : t("rejectedOf", { name: value.name }),
    (value: Verdict) =>
      api.post(`/requests/${value.id}/decide`, { approve: value.approve, note: value.note || undefined }),
    () => setOpen(null),
  );

  const many = useMutation({
    mutationFn: async (value: { approve: boolean; ids: string[]; note: string }) =>
      (await api.post<{ decided: string[]; skipped: { id: string; code: string }[] }>("/requests/decide-many", {
        ids: value.ids,
        approve: value.approve,
        note: value.note || undefined,
      })).data,
    onSuccess: (result) => {
      const first = result.skipped[0]?.code ?? "";
      notify.done(
        t("bulkDone", { decided: result.decided.length, skipped: result.skipped.length }),
        first && errors.has(first as "SELF_DECISION") ? errors(first as "SELF_DECISION") : undefined,
      );
      setBulk(null);
      setReason("");
      void cache.invalidateQueries({ queryKey: ["requests"] });
      void cache.invalidateQueries({ queryKey: ["leave-balances"] });
    },
    onError: (fell: unknown) => setBulkFault(faultOf(fell)),
  });

  const columns: Column<InboxRow>[] = [
    ...personColumns<InboxRow>(t("who"), t("department"), common("empty")),
    {
      id: "request",
      header: t("request"),
      card: (row) => `${row.leaveType?.name ?? words.kind(row)} · ${words.span(row)}`,
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate">{words.kind(row)}</span>
          <span className="text-sm whitespace-nowrap text-kumo-subtle tabular-nums">{words.span(row)}</span>
        </div>
      ),
    },
    { id: "extent", header: t("extent"), numeric: true, priority: 2, cell: (row) => words.extent(row) },
    {
      id: "balanceAfter",
      header: t("balanceAfter"),
      numeric: true,
      priority: 2,
      cell: (row) => <BalanceAfter row={row} />,
    },
    {
      id: "overlap",
      header: t("teamOff"),
      numeric: true,
      priority: 3,
      cell: (row) => (row.overlapCount === null ? common("empty") : t("people", { count: row.overlapCount })),
    },
    { id: "waited", header: t("waitedHeader"), numeric: true, cell: (row) => <Waited count={row.waitedDays} /> },
  ];

  const shown = detail.data ?? open;

  return (
    <>
      <DataTable
        id="inbox-requests"
        columns={columns}
        rows={rows}
        keyOf={(row) => row.id}
        pending={asked.isPending}
        failed={asked.isError}
        onRetry={() => void asked.refetch()}
        empty={filtered ? t("queueNoMatch") : t("queueEmpty")}
        emptyHint={filtered ? t("registerNoMatchHint") : undefined}
        cardLead="person"
        cardTrailing="waited"
        paging={paging}
        selectable
        bulk={(chosen) => (
          <>
            <Button variant="secondary" size="sm" icon={CheckIcon} onClick={() => setBulk({ approve: true, ids: chosen.map((one) => one.id) })}>
              {t("bulkApprove", { count: chosen.length })}
            </Button>
            <Button
              variant="secondary-destructive"
              size="sm"
              icon={XIcon}
              onClick={() => {
                setReason("");
                setBulk({ approve: false, ids: chosen.map((one) => one.id) });
              }}
            >
              {t("bulkReject", { count: chosen.length })}
            </Button>
          </>
        )}
        onRowClick={(row) => {
          decide.clear();
          setOpen(row);
        }}
      />

      <DecisionSheet
        key={open?.id ?? "none"}
        open={open !== null}
        onOpenChange={(next) => !next && setOpen(null)}
        person={open?.employee ?? null}
        title={shown ? words.kind(shown) : t("title")}
        approveLabel={t("approve")}
        busy={decide.mutation.isPending}
        fault={decide.fault ?? (detail.data && !detail.data.mayDecide ? errors("NOT_YOUR_REQUEST") : null)}
        handled={handled ? <Handled row={handled} /> : undefined}
        noteOnApprove
        onApprove={(note) => open && decide.mutation.mutate({ id: open.id, approve: true, note, name: open.employee?.fullName ?? "none" })}
        onReject={(note) => open && decide.mutation.mutate({ id: open.id, approve: false, note, name: open.employee?.fullName ?? "none" })}
      >
        {shown && open ? (
          <div className="flex flex-col gap-4">
            <RequestFacts
              row={shown}
              extra={handled ? [] : [...balanceFacts(open), [t("waitedHeader"), <Waited key="waited" count={open.waitedDays} />]]}
            />
            <p className="break-words">{shown.reason}</p>
            {open.kind === "LEAVE" ? (
              <div>
                <p className="mb-1 text-sm font-medium">{t("teamOffTitle")}</p>
                {detail.data ? (
                  detail.data.overlapping.length === 0 ? (
                    <p className="text-kumo-subtle">{t("teamOffNone")}</p>
                  ) : (
                    <ul className="flex flex-col">
                      {detail.data.overlapping.map((one) => (
                        <li key={one.id} className="flex items-center justify-between gap-3 border-b border-kumo-hairline py-1.5 last:border-0">
                          <span className="min-w-0 truncate">{one.employee.fullName}</span>
                          <span className="shrink-0 text-sm text-kumo-subtle tabular-nums">{words.span(one)}</span>
                        </li>
                      ))}
                    </ul>
                  )
                ) : (
                  <p className="text-kumo-subtle">{t("people", { count: open.overlapCount ?? 0 })}</p>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </DecisionSheet>

      <LayerDialog.Alert open={bulk !== null} onOpenChange={(next) => !next && setBulk(null)} dismissDisabled={many.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>
            {bulk?.approve ? t("bulkApproveTitle", { count: bulk.ids.length }) : t("bulkRejectTitle", { count: bulk?.ids.length ?? 0 })}
          </LayerDialog.Title>
          <LayerDialog.Description>{bulk?.approve ? t("bulkApproveLead") : t("bulkRejectLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            {bulk && !bulk.approve ? (
              <Textarea label={t("rejectReason")} rows={3} maxLength={500} value={reason} onValueChange={setReason} />
            ) : null}
            {bulkFault ? <p className="mt-2 text-kumo-danger">{bulkFault}</p> : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("back")}>
            <LayerDialog.Actions.Primary
              variant={bulk?.approve ? "primary" : "destructive"}
              loading={many.isPending}
              disabled={bulk !== null && !bulk.approve && reason.trim() === ""}
              onClick={() => {
                setBulkFault(null);
                if (bulk) {
                  many.mutate({ approve: bulk.approve, ids: bulk.ids, note: reason.trim() });
                }
              }}
            >
              {bulk?.approve ? t("bulkApprove", { count: bulk.ids.length }) : t("bulkReject", { count: bulk?.ids.length ?? 0 })}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </>
  );
}

function LettersQueue({ params, filtered, ...link }: QueueProps) {
  const t = useTranslations("requests");
  const c = useTranslations("certificates");
  const common = useTranslations("common");
  const format = useFormatter();
  const notify = useNotify();
  const handled = useHandled();
  const asked = useQueue<Letter>(["certificates", "queue"], "/certificates", { ...params, state: "REQUESTED" });
  const { rows, paging } = usePaging(asked);
  const [open, setOpen] = useState<Letter | null>(null);
  const decide = useSheetMutation<Verdict>(
    "certificates",
    (value: { approve: boolean; name: string }) =>
      value.approve ? t("issuedTo", { name: value.name }) : t("rejectedOf", { name: value.name }),
    (value: Verdict) =>
      api.post(`/certificates/${value.id}/${value.approve ? "issue" : "reject"}`, value.approve ? {} : { note: value.note }),
    () => setOpen(null),
    (value) => api.get<Letter>(`/certificates/${value.id}`).then((held) => setOpen(held.data), notify.failed),
  );
  const show = (row: Letter) => {
    decide.clear();
    setOpen(row);
  };
  useLinkedRow(link, asked, show, "/certificates");
  const said = (row: Letter): Said | null =>
    !row.state || row.state === "REQUESTED"
      ? null
      : row.state === "CANCELLED"
        ? { key: "handledWithdrawn" }
        : { key: row.state === "ISSUED" ? "handledISSUED" : "handledREJECTED", who: row.decidedByName, at: row.issuedAt ?? row.updatedAt, note: row.note };
  const kindOf = (row: Letter) => (row.kind === "INCOME" && row.months ? `${c(row.kind)} · ${c("monthsN", { count: row.months })}` : c(row.kind));
  const columns: Column<Letter>[] = [
    ...personColumns<Letter>(t("who"), t("department"), common("empty")),
    { id: "kind", header: c("kind"), cell: kindOf },
    { id: "purpose", header: c("purpose"), priority: 3, truncate: true, cell: (row) => row.purpose },
    { id: "waited", header: t("waitedHeader"), numeric: true, cell: (row) => <Waited count={waitedSince(row)} /> },
  ];
  return (
    <>
      <DataTable
        id="inbox-letters"
        columns={columns}
        rows={rows}
        keyOf={(row) => row.id}
        pending={asked.isPending}
        failed={asked.isError}
        onRetry={() => void asked.refetch()}
        empty={filtered ? t("queueNoMatch") : t("queueEmpty")}
        cardLead="person"
        cardTrailing="waited"
        paging={paging}
        onRowClick={show}
      />
      <DecisionSheet
        key={open?.id ?? "none"}
        open={open !== null}
        onOpenChange={(next) => !next && setOpen(null)}
        person={open?.employee ?? null}
        title={open ? kindOf(open) : c("title")}
        approveLabel={c("issue")}
        busy={decide.mutation.isPending}
        fault={decide.fault}
        handled={open ? handled(said(open)) : undefined}
        onApprove={(note) => open && decide.mutation.mutate({ id: open.id, approve: true, note, name: open.employee.fullName })}
        onReject={(note) => open && decide.mutation.mutate({ id: open.id, approve: false, note, name: open.employee.fullName })}
      >
        {open ? (
          <Facts
            rows={[
              [c("kind"), kindOf(open)],
              [c("purpose"), open.purpose],
              [c("askedOn"), format.dateTime(new Date(open.createdAt), "day")],
            ]}
          />
        ) : null}
      </DecisionSheet>
    </>
  );
}

function reads(values: Record<string, string | null> | null, blank: string): string {
  const shown = Object.values(values ?? {}).filter((one) => one !== null && one !== "");
  return shown.length > 0 ? shown.join(" · ") : blank;
}

function ChangesQueue({ params, filtered, ...link }: QueueProps) {
  const t = useTranslations("requests");
  const p = useTranslations("profile");
  const common = useTranslations("common");
  const notify = useNotify();
  const handled = useHandled();
  const asked = useQueue<Change>(["profile-changes", "queue"], "/profile-changes", { ...params, state: "PENDING" });
  const { rows, paging } = usePaging(asked);
  const [open, setOpen] = useState<Change | null>(null);
  const decide = useSheetMutation<Verdict>(
    "profile-changes",
    (value: { approve: boolean; name: string }) =>
      value.approve ? t("approvedOf", { name: value.name }) : t("rejectedOf", { name: value.name }),
    (value: Verdict) =>
      api.post(`/profile-changes/${value.id}/${value.approve ? "approve" : "reject"}`, value.approve ? {} : { note: value.note }),
    () => setOpen(null),
    (value) => api.get<Change>(`/profile-changes/${value.id}`).then((held) => setOpen(held.data), notify.failed),
  );
  const show = (row: Change) => {
    decide.clear();
    setOpen(row);
  };
  useLinkedRow(link, asked, show, "/profile-changes");
  const said = (row: Change): Said | null =>
    !row.state || row.state === "PENDING"
      ? null
      : row.state === "CANCELLED"
        ? { key: "handledWithdrawn" }
        : { key: `handled${row.state}`, who: row.decidedByName, at: row.decidedAt, note: row.note };
  const columns: Column<Change>[] = [
    ...personColumns<Change>(t("who"), t("department"), common("empty")),
    { id: "field", header: p("field"), cell: (row) => p(`field${row.field}`) },
    {
      id: "change",
      header: p("change"),
      priority: 2,
      truncate: true,
      cell: (row) => `${reads(row.oldValue, p("blank"))} → ${reads(row.newValue, p("blank"))}`,
    },
    { id: "waited", header: t("waitedHeader"), numeric: true, cell: (row) => <Waited count={waitedSince(row)} /> },
  ];
  return (
    <>
      <DataTable
        id="inbox-changes"
        columns={columns}
        rows={rows}
        keyOf={(row) => row.id}
        pending={asked.isPending}
        failed={asked.isError}
        onRetry={() => void asked.refetch()}
        empty={filtered ? t("queueNoMatch") : t("queueEmpty")}
        cardLead="person"
        cardTrailing="waited"
        paging={paging}
        onRowClick={show}
      />
      <DecisionSheet
        key={open?.id ?? "none"}
        open={open !== null}
        onOpenChange={(next) => !next && setOpen(null)}
        person={open?.employee ?? null}
        title={open ? p(`field${open.field}`) : p("title")}
        approveLabel={p("approve")}
        busy={decide.mutation.isPending}
        fault={decide.fault}
        handled={open ? handled(said(open)) : undefined}
        onApprove={(note) => open && decide.mutation.mutate({ id: open.id, approve: true, note, name: open.employee.fullName })}
        onReject={(note) => open && decide.mutation.mutate({ id: open.id, approve: false, note, name: open.employee.fullName })}
      >
        {open ? (
          <Facts
            rows={[
              [p("held"), reads(open.oldValue, p("blank"))],
              [p("change"), reads(open.newValue, p("blank"))],
              ...(open.reason ? [[t("reason"), open.reason] as [string, ReactNode]] : []),
            ]}
          />
        ) : null}
      </DecisionSheet>
    </>
  );
}

function DisputesQueue({ params, filtered, ...link }: QueueProps) {
  const t = useTranslations("requests");
  const d = useTranslations("disputes");
  const common = useTranslations("common");
  const format = useFormatter();
  const optional = useOptional();
  const lineName = useLineName();
  const notify = useNotify();
  const handled = useHandled();
  const asked = useQueue<Claim>(["payslip-disputes", "queue"], "/payslip-disputes", { ...params, state: "OPEN" });
  const { rows, paging } = usePaging(asked);
  const [open, setOpen] = useState<Claim | null>(null);
  const [answer, setAnswer] = useState("");
  const [amount, setAmount] = useState("");
  const [missing, setMissing] = useState(false);
  const decide = useSheetMutation(
    "payslip-disputes",
    () => t("answeredDone"),
    (value: { id: string; outcome: "UPHELD" | "REJECTED" }) =>
      api.post(`/payslip-disputes/${value.id}/answer`, {
        outcome: value.outcome,
        answer: answer.trim(),
        ...(value.outcome === "UPHELD" && amount !== "" ? { amount: Number(amount) } : {}),
      }),
    () => setOpen(null),
    (value) => api.get<Claim>(`/payslip-disputes/${value.id}`).then((held) => setOpen(held.data), notify.failed),
  );
  const period = (row: Claim) => `${String(row.payslip.period.month).padStart(2, "0")}/${row.payslip.period.year}`;
  const late = (row: Claim) => new Date(row.dueAt).getTime() < Date.now();
  const show = (row: Claim) => {
    decide.clear();
    setAnswer("");
    setAmount("");
    setMissing(false);
    setOpen(row);
  };
  // A dispute notice names the payslip it is about, so a link may carry either id.
  useLinkedRow(link, asked, show, "/payslip-disputes", (row, id) => row.id === id || row.payslipId === id);
  const said = (row: Claim): Said | null =>
    !row.state || row.state === "OPEN"
      ? null
      : row.state === "WITHDRAWN"
        ? { key: "handledWithdrawn" }
        : { key: row.outcome === "UPHELD" ? "handledUPHELD" : "handledREJECTED", who: row.decidedByName, at: row.answeredAt, note: row.answer };
  const closed = open ? said(open) : null;
  const columns: Column<Claim>[] = [
    ...personColumns<Claim>(t("who"), t("department"), common("empty")),
    {
      id: "line",
      header: d("line"),
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate">{row.lineCode ? lineName(row.lineCode) : d("lineAny")}</span>
          <span className="text-sm text-kumo-subtle tabular-nums">{period(row)}</span>
        </div>
      ),
    },
    { id: "claim", header: d("claim"), priority: 3, truncate: true, cell: (row) => row.claim },
    {
      id: "due",
      header: d("due"),
      priority: 2,
      cell: (row) =>
        late(row) ? <StatePill tone="bad">{d("overdue")}</StatePill> : format.dateTime(new Date(row.dueAt), "day"),
    },
    { id: "waited", header: t("waitedHeader"), numeric: true, cell: (row) => <Waited count={waitedSince(row)} /> },
  ];

  function send(outcome: "UPHELD" | "REJECTED"): void {
    if (answer.trim() === "") {
      setMissing(true);
      return;
    }
    if (open) {
      decide.mutation.mutate({ id: open.id, outcome });
    }
  }

  return (
    <>
      <DataTable
        id="inbox-disputes"
        columns={columns}
        rows={rows}
        keyOf={(row) => row.id}
        pending={asked.isPending}
        failed={asked.isError}
        onRetry={() => void asked.refetch()}
        empty={filtered ? t("queueNoMatch") : t("queueEmpty")}
        cardLead="person"
        cardTrailing="waited"
        paging={paging}
        onRowClick={show}
      />
      <LayerDialog.Root open={open !== null} onOpenChange={(next) => !next && setOpen(null)} dismissDisabled={decide.mutation.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{open?.employee.fullName ?? d("title")}</LayerDialog.Title>
          <LayerDialog.Description>
            {open ? [open.employee.code, open.employee.department?.name, period(open)].filter(Boolean).join(" · ") : ""}
          </LayerDialog.Description>
          <LayerDialog.Body>
            {open ? (
              <div className="flex flex-col gap-4">
                <Facts
                  rows={[
                    [d("line"), open.lineCode ? lineName(open.lineCode) : d("lineAny")],
                    [late(open) ? d("overdue") : d("due"), format.dateTime(new Date(open.dueAt), "day")],
                  ]}
                />
                <p className="break-words">{open.claim}</p>
                {closed ? handled(closed) : null}
                {closed ? null : (
                  <>
                    <Textarea
                      label={d("answer")}
                      placeholder={d("answerHint")}
                      rows={3}
                      maxLength={2000}
                      value={answer}
                      error={missing ? common("required") : undefined}
                      variant={missing ? "error" : "default"}
                      onValueChange={(next) => {
                        setAnswer(next);
                        setMissing(false);
                      }}
                    />
                    <Input
                      label={optional(d("amount"))}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      value={amount}
                      description={d("amountHint")}
                      onChange={(event) => setAmount(event.target.value)}
                    />
                    {decide.fault ? <p className="text-kumo-danger">{decide.fault}</p> : null}
                    <Button
                      variant="secondary-destructive"
                      icon={XIcon}
                      className="self-start"
                      disabled={decide.mutation.isPending}
                      onClick={() => send("REJECTED")}
                    >
                      {d("turnDown")}
                    </Button>
                  </>
                )}
              </div>
            ) : null}
          </LayerDialog.Body>
          {closed ? null : (
            <LayerDialog.Actions dismissLabel={common("close")}>
              <LayerDialog.Actions.Primary loading={decide.mutation.isPending} onClick={() => send("UPHELD")}>
                {d("uphold")}
              </LayerDialog.Actions.Primary>
            </LayerDialog.Actions>
          )}
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}

function AdvancesQueue({ params, filtered, paying, ...link }: QueueProps & { paying: boolean }) {
  const t = useTranslations("requests");
  const pay = useTranslations("payroll");
  const common = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();
  const notify = useNotify();
  const handled = useHandled();
  const asked = useQueue<Advance>(["advances", "queue", paying ? "pay" : "decide"], "/advances", {
    ...params,
    state: paying ? "APPROVED" : "PENDING",
  });
  const { rows, paging } = usePaging(asked);
  const [open, setOpen] = useState<Advance | null>(null);
  const decide = useSheetMutation<Verdict>(
    "advances",
    (value: { approve: boolean; name: string }) =>
      paying ? t("paidTo", { name: value.name }) : value.approve ? t("approvedOf", { name: value.name }) : t("rejectedOf", { name: value.name }),
    (value: Verdict) =>
      paying
        ? api.post(`/advances/${value.id}/paid`, {})
        : api.post(`/advances/${value.id}/decide`, { approve: value.approve, note: value.note || undefined }),
    () => setOpen(null),
    (value) => api.get<Advance>(`/advances/${value.id}`).then((held) => setOpen(held.data), notify.failed),
  );
  const cash = (value: string | null) => (value === null ? common("empty") : money(Number(value), locale));
  const show = (row: Advance) => {
    decide.clear();
    setOpen(row);
  };
  useLinkedRow(link, asked, show, "/advances");
  const said = (row: Advance): Said | null => {
    if (!row.state || row.state === (paying ? "APPROVED" : "PENDING")) {
      return null;
    }
    if (row.state === "PAID" || row.state === "SETTLED") {
      return paying ? { key: "handledPAID", at: row.paidAt } : { key: "handledAPPROVED", who: row.decidedByName, at: row.decidedAt, note: row.decisionNote };
    }
    if (row.state === "APPROVED" || row.state === "REJECTED") {
      return { key: `handled${row.state}`, who: row.decidedByName, at: row.decidedAt, note: row.decisionNote };
    }
    return { key: "handledWithdrawn" };
  };
  const closed = open ? said(open) : null;
  const columns: Column<Advance>[] = [
    ...personColumns<Advance>(t("who"), t("department"), common("empty")),
    { id: "amount", header: pay("advanceAmount"), numeric: true, cell: (row) => cash(row.amount) },
    ...(paying
      ? [
          {
            id: "decidedAt",
            header: t("decidedAtHeader"),
            priority: 2 as const,
            cell: (row: Advance) => (row.decidedAt ? format.dateTime(new Date(row.decidedAt), "day") : common("empty")),
          },
        ]
      : [
          { id: "base", header: t("baseSalary"), numeric: true, priority: 2 as const, cell: (row: Advance) => cash(row.baseSalary) },
          { id: "owed", header: t("outstanding"), numeric: true, priority: 2 as const, cell: (row: Advance) => cash(row.outstanding) },
        ]),
    { id: "reason", header: t("reason"), priority: 3, truncate: true, cell: (row) => row.reason },
    {
      id: "waited",
      header: t("waitedHeader"),
      numeric: true,
      cell: (row) => <Waited count={row.waitedDays} />,
    },
  ];
  return (
    <>
      <DataTable
        id={paying ? "inbox-to-pay" : "inbox-advances"}
        columns={columns}
        rows={rows}
        keyOf={(row) => row.id}
        pending={asked.isPending}
        failed={asked.isError}
        onRetry={() => void asked.refetch()}
        empty={filtered ? t("queueNoMatch") : t("queueEmpty")}
        cardLead="person"
        cardTrailing="amount"
        paging={paging}
        onRowClick={show}
      />
      {paying ? (
        <LayerDialog.Alert open={open !== null} onOpenChange={(next) => !next && setOpen(null)} dismissDisabled={decide.mutation.isPending}>
          <LayerDialog.Content closeLabel={common("close")}>
            <LayerDialog.Title>
              {open ? t("payTitle", { amount: cash(open.amount), name: open.employee.fullName }) : pay("advanceToPay")}
            </LayerDialog.Title>
            <LayerDialog.Description>{t("payLead")}</LayerDialog.Description>
            <LayerDialog.Body>
              {open ? <p className="line-clamp-3 text-kumo-subtle">{open.reason}</p> : null}
              {closed ? handled(closed) : null}
              {decide.fault ? <p className="mt-2 text-kumo-danger">{decide.fault}</p> : null}
            </LayerDialog.Body>
            {closed ? null : (
              <LayerDialog.Actions dismissLabel={common("back")}>
                <LayerDialog.Actions.Primary
                  loading={decide.mutation.isPending}
                  onClick={() => open && decide.mutation.mutate({ id: open.id, approve: true, note: "", name: open.employee.fullName })}
                >
                  {pay("advancePay")}
                </LayerDialog.Actions.Primary>
              </LayerDialog.Actions>
            )}
          </LayerDialog.Content>
        </LayerDialog.Alert>
      ) : (
        <DecisionSheet
          key={open?.id ?? "none"}
          open={open !== null}
          onOpenChange={(next) => !next && setOpen(null)}
          person={open?.employee ?? null}
          title={pay("advances")}
          approveLabel={t("approve")}
          busy={decide.mutation.isPending}
          fault={decide.fault}
          handled={closed ? handled(closed) : undefined}
          noteOnApprove
          onApprove={(note) => open && decide.mutation.mutate({ id: open.id, approve: true, note, name: open.employee.fullName })}
          onReject={(note) => open && decide.mutation.mutate({ id: open.id, approve: false, note, name: open.employee.fullName })}
        >
          {open ? (
            <div className="flex flex-col gap-3">
              <Facts
                rows={[
                  [pay("advanceAmount"), cash(open.amount)],
                  [t("baseSalary"), cash(open.baseSalary)],
                  [t("outstanding"), cash(open.outstanding)],
                  [pay("advanceAt"), format.dateTime(new Date(open.requestedAt), "day")],
                ]}
              />
              <p className="break-words">{open.reason}</p>
            </div>
          ) : null}
        </DecisionSheet>
      )}
    </>
  );
}

function DependentsQueue({ params, filtered, ...link }: QueueProps) {
  const t = useTranslations("requests");
  const me = useTranslations("me");
  const common = useTranslations("common");
  const format = useFormatter();
  const notify = useNotify();
  const handled = useHandled();
  const asked = useQueue<Dependent>(["dependents", "queue"], "/dependents", { ...params, state: "PENDING" });
  const { rows, paging } = usePaging(asked);
  const [open, setOpen] = useState<Dependent | null>(null);
  const decide = useSheetMutation<Verdict>(
    "dependents",
    (value: { approve: boolean; name: string }) =>
      value.approve ? t("approvedOf", { name: value.name }) : t("rejectedOf", { name: value.name }),
    (value: Verdict) =>
      api.post(`/dependents/${value.id}/decide`, { approve: value.approve, note: value.note || undefined }),
    () => setOpen(null),
    (value) => api.get<Dependent>(`/dependents/${value.id}`).then((held) => setOpen(held.data), notify.failed),
  );
  const month = (row: Dependent) => format.dateTime(dayOnly(row.fromMonth), { month: "2-digit", year: "numeric" });
  const show = (row: Dependent) => {
    decide.clear();
    setOpen(row);
  };
  useLinkedRow(link, asked, show, "/dependents");
  const said = (row: Dependent): Said | null =>
    !row.state || row.state === "PENDING"
      ? null
      : { key: row.state === "REJECTED" ? "handledREJECTED" : "handledAPPROVED", who: row.decidedByName, at: row.decidedAt, note: row.decisionNote };
  const columns: Column<Dependent>[] = [
    ...personColumns<Dependent>(t("who"), t("department"), common("empty")),
    {
      id: "dependent",
      header: me("dependentName"),
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate">{row.fullName}</span>
          <span className="text-sm text-kumo-subtle">{me(`relation${row.relation}`)}</span>
        </div>
      ),
    },
    { id: "from", header: me("dependentFrom"), priority: 2, cell: month },
    { id: "waited", header: t("waitedHeader"), numeric: true, cell: (row) => <Waited count={waitedSince(row)} /> },
  ];
  return (
    <>
      <DataTable
        id="inbox-dependents"
        columns={columns}
        rows={rows}
        keyOf={(row) => row.id}
        pending={asked.isPending}
        failed={asked.isError}
        onRetry={() => void asked.refetch()}
        empty={filtered ? t("queueNoMatch") : t("queueEmpty")}
        cardLead="person"
        cardTrailing="waited"
        paging={paging}
        onRowClick={show}
      />
      <DecisionSheet
        key={open?.id ?? "none"}
        open={open !== null}
        onOpenChange={(next) => !next && setOpen(null)}
        person={open?.employee ?? null}
        title={me("dependentsTitle")}
        approveLabel={t("approve")}
        busy={decide.mutation.isPending}
        fault={decide.fault}
        handled={open ? handled(said(open)) : undefined}
        onApprove={(note) => open && decide.mutation.mutate({ id: open.id, approve: true, note, name: open.employee.fullName })}
        onReject={(note) => open && decide.mutation.mutate({ id: open.id, approve: false, note, name: open.employee.fullName })}
      >
        {open ? (
          <Facts
            rows={[
              [me("dependentName"), open.fullName],
              [me("dependentRelation"), me(`relation${open.relation}`)],
              [me("dependentFrom"), month(open)],
            ]}
          />
        ) : null}
      </DecisionSheet>
    </>
  );
}

function Inbox() {
  const t = useTranslations("requests");
  const c = useTranslations("certificates");
  const p = useTranslations("profile");
  const common = useTranslations("common");
  const role = useSession((s) => s.role);
  const counts = useInboxCounts(role);
  const [url, setUrl] = useUrlState<UrlState>(DEFAULTS);
  const [typed, setTyped] = useState(url.q);
  const settled = useSettled(typed.trim());

  useEffect(() => {
    if (settled !== url.q) {
      setUrl({ q: settled });
    }
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Department[]>("/departments")).data,
  });

  const LABEL: Record<Queue, string> = {
    requests: t("queueRequests"),
    disputes: t("queueDisputes"),
    certificates: t("queueCertificates"),
    profileChanges: t("queueProfile"),
    dependents: t("queueDependents"),
    advancesToDecide: t("queueAdvances"),
    advancesToPay: t("queueToPay"),
  };
  const visible = QUEUE_ORDER.filter((one) => role !== null && QUEUE_ROLES[one].includes(role));
  const busiest = visible.find((one) => (counts.data?.[one] ?? 0) > 0) ?? visible[0];
  const tab = (visible as string[]).includes(url.tab) ? (url.tab as Queue) : busiest;
  const waiting = counts.data ? visible.reduce((total, one) => total + counts.data[one], 0) : undefined;
  // An empty queue has nothing to decide, so its tab only stays while it is the one open.
  const shown = counts.data ? visible.filter((one) => one === tab || counts.data[one] > 0) : visible;

  const params = useMemo(
    () => ({
      search: url.q,
      departmentId: url.dept,
      from: url.from,
      to: url.to,
      order: url.order || "asc",
      ...(tab === "requests" && url.kind ? { kind: url.kind } : {}),
      ...(tab === "certificates" && url.kind ? { kind: url.kind } : {}),
      ...(tab === "profileChanges" && url.kind ? { field: url.kind } : {}),
    }),
    [url.q, url.dept, url.from, url.to, url.order, url.kind, tab],
  );
  const filtered = url.q !== "" || url.dept !== "" || url.from !== "" || url.to !== "" || url.kind !== "";
  const link: Linked = { openId: url.open, onOpened: () => setUrl({ open: "" }) };

  const kinds: Record<string, string> | null =
    tab === "requests"
      ? { "": t("anyKind"), ...Object.fromEntries(REQUEST_KINDS.map((one: RequestKind) => [one, t(`kind${one}`)])) }
      : tab === "certificates"
        ? { "": t("anyKind"), ...Object.fromEntries(LETTER_KINDS.map((one) => [one, c(one)])) }
        : tab === "profileChanges"
          ? { "": t("anyKind"), ...Object.fromEntries(PROFILE_FIELDS.map((one) => [one, p(`field${one}`)])) }
          : null;

  const filters: Filter[] = [
    ...(kinds ? [{ key: "kind", label: t("kind"), value: url.kind, onChange: (next: string) => setUrl({ kind: next }), items: kinds }] : []),
    {
      key: "dept",
      label: t("department"),
      value: url.dept,
      searchable: true,
      onChange: (next) => setUrl({ dept: next }),
      items: { "": t("anyDepartment"), ...Object.fromEntries((departments.data ?? []).map((one) => [one.id, one.name])) },
    },
    {
      key: "order",
      label: t("order"),
      value: url.order,
      onChange: (next) => setUrl({ order: next }),
      items: { "": t("orderOldest"), desc: t("orderNewest") },
    },
  ];

  return (
    <>
      <PageHeader
        title={t("approvalsTitle")}
        description={t("approvalsLead")}
        meta={waiting ? <CountPill>{waiting}</CountPill> : undefined}
        tabs={shown.map((one) => ({
          value: one,
          label: (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              {LABEL[one]}
              {counts.data ? <CountPill>{counts.data[one]}</CountPill> : null}
            </span>
          ),
        }))}
        tab={tab}
        onTab={(next) => setUrl({ tab: next, kind: "" })}
      />

      <PageLayout>
        <FilterBar
          search={{ value: typed, onChange: setTyped, placeholder: t("inboxSearch") }}
          filters={filters}
          range={{ from: url.from, to: url.to, onFrom: (next) => setUrl({ from: next }), onTo: (next) => setUrl({ to: next }) }}
        />
        {tab === "requests" ? <RequestsQueue params={params} filtered={filtered} {...link} /> : null}
        {tab === "certificates" ? <LettersQueue params={params} filtered={filtered} {...link} /> : null}
        {tab === "profileChanges" ? <ChangesQueue params={params} filtered={filtered} {...link} /> : null}
        {tab === "disputes" ? <DisputesQueue params={params} filtered={filtered} {...link} /> : null}
        {tab === "advancesToDecide" ? <AdvancesQueue params={params} filtered={filtered} paying={false} {...link} /> : null}
        {tab === "advancesToPay" ? <AdvancesQueue params={params} filtered={filtered} paying {...link} /> : null}
        {tab === "dependents" ? <DependentsQueue params={params} filtered={filtered} {...link} /> : null}
      </PageLayout>
    </>
  );
}

// The tab and the filters ride on the query string, which the prerender does not have.
export default function ApprovalsPage() {
  return (
    <Suspense>
      <Inbox />
    </Suspense>
  );
}
