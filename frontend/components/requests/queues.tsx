"use client";

import { Button, Input, LayerDialog, Textarea } from "@cloudflare/kumo";
import { ArrowRightIcon, CheckIcon, XIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";

import { COUNTS_KEY, QUEUE_ROLES, WAITING_POLL_MS, type Queue } from "@/components/nav/waiting-count";
import { useReadSubject } from "@/components/notifications/notice-row";
import { useLineName } from "@/components/payroll/payslip-view";
import {
  DecisionFields,
  RequestFacts,
  useDecision,
  leftByYear,
  useRequestWords,
  type InboxRow,
  type RequestDetail,
  type RequestRow,
} from "@/components/requests/request-card";
import { DataTable, PersonCell, type Column, type Paging } from "@/components/tables/data-table";
import { useNotify } from "@/components/ui/notify";
import { useOptional } from "@/components/ui/optional";
import { Facts } from "@/components/ui/page";
import { StatePill, type Tone } from "@/components/ui/pill";
import { SkeletonLine } from "@/components/ui/skeleton";
import { useRouter } from "@/i18n/navigation";
import { api, queryOf } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { dayOnly, days, money } from "@/lib/format";

const kPage = 50;
const kDayMs = 86_400_000;
/** The two letters a person can ask the desk for. */
export const LETTER_KINDS = ["EMPLOYMENT", "INCOME"] as const;
/** The parts of a record a person can ask to change. */
export const PROFILE_FIELDS = ["PERSONAL_EMAIL", "PHONE", "BANK", "NATIONAL_ID", "TAX_CODE", "SOCIAL_INSURANCE_NO"] as const;
/** The inbox's queues in tab order; the register follows the same order (KEHOACH 9.15). */
export const QUEUE_ORDER: Queue[] = [
  "requests",
  "disputes",
  "certificates",
  "profileChanges",
  "punches",
  "dependents",
  "advancesToDecide",
  "advancesToPay",
];

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

interface HeldPunch {
  id: string;
  deviceId: string;
  ts: string;
  direction: "IN" | "OUT";
  receivedAt: string | null;
  hold: "LATE" | "CLOSED_PERIOD";
  waitedDays: number;
  employee: Who;
}

interface Verdict {
  id: string;
  approve: boolean;
  note: string;
  name: string;
}

const LETTER_TONE: Record<NonNullable<Letter["state"]>, Tone> = { REQUESTED: "waiting", ISSUED: "good", REJECTED: "bad", CANCELLED: "idle" };
const CHANGE_TONE: Record<NonNullable<Change["state"]>, Tone> = { PENDING: "waiting", APPROVED: "good", REJECTED: "bad", CANCELLED: "idle" };
const CLAIM_TONE: Record<NonNullable<Claim["state"]>, Tone> = { OPEN: "waiting", ANSWERED: "good", WITHDRAWN: "idle" };
// An approved advance still waits on the pay desk, so it reads as waiting until it is paid.
const ADVANCE_TONE: Record<NonNullable<Advance["state"]>, Tone> = {
  PENDING: "waiting",
  APPROVED: "waiting",
  REJECTED: "bad",
  PAID: "good",
  SETTLED: "good",
  CANCELLED: "idle",
};
const DEPENDENT_TONE: Record<NonNullable<Dependent["state"]>, Tone> = { PENDING: "waiting", ACTIVE: "good", REJECTED: "bad", ENDED: "idle" };

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
      (await api.get<Page<T>>(`${path}${queryOf({ ...params, take: String(kPage), cursor: pageParam })}`)).data,
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

/** The item a notice opened the page for, and how the page forgets it once shown. */
export interface Linked {
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

/** The inbox row that decides an item, or null when this viewer holds no queue that answers it. */
function useInboxLink(): (queue: Queue, id: string) => (() => void) | null {
  const role = useSession((held) => held.role);
  const router = useRouter();
  return (queue, id) =>
    role !== null && QUEUE_ROLES[queue].includes(role) ? () => router.push(`/approvals?tab=${queue}&open=${id}`) : null;
}

/** A waiting item seen from the register, which decides nothing itself (KEHOACH 9.15). */
function useWaiting(): (go: (() => void) | null) => ReactNode {
  const t = useTranslations("requests");
  return (go) => (
    <div className="mt-4 flex flex-col items-start gap-3 border-t border-kumo-hairline pt-4">
      <p className="font-medium">{t("ledgerWaiting")}</p>
      {go ? (
        <Button variant="secondary" icon={ArrowRightIcon} onClick={go}>
          {t("ledgerDecide")}
        </Button>
      ) : null}
    </div>
  );
}

/** Who decided an item and when, or a null name while nobody has. */
export interface Decider {
  name: string | null | undefined;
  at: string | null | undefined;
}

/** The three columns every register tab ends on, in place of the queue's wait (KEHOACH 9.15). */
export function useLedgerColumns<T>(
  filedOf: (row: T) => string,
  stateOf: (row: T) => ReactNode,
  deciderOf: (row: T) => Decider,
): Column<T>[] {
  const t = useTranslations("requests");
  const common = useTranslations("common");
  const format = useFormatter();
  return [
    {
      id: "filed",
      header: t("filed"),
      priority: 2,
      sortKey: "createdAt",
      cell: (row) => <span className="whitespace-nowrap tabular-nums">{format.dateTime(new Date(filedOf(row)), "day")}</span>,
    },
    { id: "state", header: t("state"), cell: stateOf },
    {
      id: "decidedBy",
      header: t("decidedBy"),
      priority: 3,
      cell: (row) => {
        const { name, at } = deciderOf(row);
        return name ? (
          <div className="flex min-w-0 flex-col">
            <span className="truncate">{name}</span>
            {at ? <span className="text-sm text-kumo-subtle tabular-nums">{format.dateTime(new Date(at), "day")}</span> : null}
          </div>
        ) : (
          common("empty")
        );
      },
    },
  ];
}

/** The register's order by filing day, which the filed header flips. */
export interface LedgerOrder {
  dir: "asc" | "desc";
  onDir: (dir: "asc" | "desc") => void;
}

function sortedLedger(order: LedgerOrder | undefined) {
  return order
    ? { sort: { key: "createdAt", dir: order.dir }, onSortChange: (next: { key: string; dir: "asc" | "desc" }) => order.onDir(next.dir) }
    : {};
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

/** Who filed it and their department, the two columns every queue and register tab opens with. */
export function personColumns<T extends { employee: Who | null }>(who: string, department: string, empty: string): Column<T>[] {
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

/** What a queue reads and how it shows it. */
export interface QueueProps extends Linked {
  params: Record<string, string>;
  filtered: boolean;
  /** The register's view: every state, the filing day in place of the wait, no decision (KEHOACH 9.15). */
  ledger?: boolean;
  order?: LedgerOrder;
}

/** Who else is off across a leave: named once the request's record is read, counted or held until then. */
function TeamOff({ detail, counted }: { detail: RequestDetail | undefined; counted?: number }) {
  const t = useTranslations("requests");
  const words = useRequestWords();
  return (
    <div>
      <p className="mb-1 text-sm font-medium">{t("teamOffTitle")}</p>
      {detail ? (
        detail.overlapping.length === 0 ? (
          <p className="text-kumo-subtle">{t("teamOffNone")}</p>
        ) : (
          <ul className="flex flex-col">
            {detail.overlapping.map((one) => (
              <li key={one.id} className="flex items-center justify-between gap-3 border-b border-kumo-hairline py-1.5 last:border-0">
                <span className="min-w-0 truncate">{one.employee.fullName}</span>
                <span className="shrink-0 text-sm text-kumo-subtle tabular-nums">{words.span(one)}</span>
              </li>
            ))}
          </ul>
        )
      ) : counted === undefined ? (
        <SkeletonLine minWidth={30} maxWidth={50} />
      ) : (
        <p className="text-kumo-subtle">{t("people", { count: counted })}</p>
      )}
    </div>
  );
}

/** One request opened from the register, read-only: what came of it, or where it waits (KEHOACH 9.15). */
export function RequestLedgerSheet({ row, onClose }: { row: RequestRow | null; onClose: () => void }) {
  const t = useTranslations("requests");
  const common = useTranslations("common");
  const words = useRequestWords();
  const waiting = useWaiting();
  const inbox = useInboxLink();
  useReadSubject("REQUEST", row?.id);
  const detail = useQuery({
    queryKey: ["requests", "one", row?.id],
    enabled: row !== null,
    queryFn: async () => (await api.get<RequestDetail>(`/requests/${row?.id ?? ""}`)).data,
  });
  const shown = detail.data ?? row;
  return (
    <LayerDialog.Root open={row !== null} onOpenChange={(next) => !next && onClose()}>
      <LayerDialog.Content size="lg" closeLabel={common("close")}>
        <LayerDialog.Title>{row?.employee?.fullName ?? t("title")}</LayerDialog.Title>
        <LayerDialog.Description>
          {shown ? [shown.employee?.code, shown.employee?.department?.name, words.kind(shown)].filter(Boolean).join(" · ") : ""}
        </LayerDialog.Description>
        <LayerDialog.Body>
          {shown ? (
            <div className="flex flex-col gap-4">
              <RequestFacts row={shown} />
              <p className="break-words">{shown.reason}</p>
              {shown.kind === "LEAVE" ? <TeamOff detail={detail.data} /> : null}
            </div>
          ) : null}
          {!shown ? null : shown.state === "PENDING" ? (
            waiting(detail.data?.mayDecide ? inbox("requests", shown.id) : null)
          ) : (
            <Handled row={shown} />
          )}
        </LayerDialog.Body>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

/** The requests waiting on this viewer, decided in a sheet with the balance and who else is off. */
export function RequestsQueue({ params, filtered, openId, onOpened }: QueueProps) {
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
  useReadSubject("REQUEST", open?.id);
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
            {open.kind === "LEAVE" ? <TeamOff detail={detail.data} counted={open.overlapCount ?? 0} /> : null}
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

// Punches stored but held back from the timesheet until someone at the HR desk decides them (KEHOACH 9.8).
/** Kiosk punches held for review, kept or dropped one by one or many at once. */
export function PunchesQueue({ params, filtered }: QueueProps) {
  const t = useTranslations("requests");
  const a = useTranslations("attendance");
  const common = useTranslations("common");
  const errors = useTranslations("errors");
  const format = useFormatter();
  const notify = useNotify();
  const faultOf = useFault();
  const cache = useQueryClient();
  const asked = useQueue<HeldPunch>(["attendance", "held"], "/attendance/held", params);
  const { rows, paging } = usePaging(asked);
  const [open, setOpen] = useState<HeldPunch | null>(null);
  const [bulk, setBulk] = useState<{ approve: boolean; ids: string[] } | null>(null);
  const [reason, setReason] = useState("");
  const [bulkFault, setBulkFault] = useState<string | null>(null);
  const stamp = (iso: string | null) => (iso ? format.dateTime(new Date(iso), "medium") : common("empty"));

  const decide = useSheetMutation<Verdict>(
    "attendance",
    (value: { approve: boolean; name: string }) =>
      value.approve ? t("punchAcceptedOf", { name: value.name }) : t("punchRejectedOf", { name: value.name }),
    (value: Verdict) =>
      api.post(`/attendance/held/${value.id}/decide`, { approve: value.approve, note: value.note || undefined }),
    () => setOpen(null),
  );

  const many = useMutation({
    mutationFn: async (value: { approve: boolean; ids: string[]; note: string }) =>
      (await api.post<{ decided: string[]; skipped: { id: string; code: string }[] }>("/attendance/held/decide-many", {
        ids: value.ids,
        approve: value.approve,
        note: value.note || undefined,
      })).data,
    onSuccess: (result) => {
      const first = result.skipped[0]?.code ?? "";
      notify.done(
        t("punchBulkDone", { decided: result.decided.length, skipped: result.skipped.length }),
        first && errors.has(first as "SELF_DECISION") ? errors(first as "SELF_DECISION") : undefined,
      );
      setBulk(null);
      setReason("");
      void cache.invalidateQueries({ queryKey: ["attendance"] });
      void cache.invalidateQueries({ queryKey: COUNTS_KEY });
    },
    onError: (fell: unknown) => setBulkFault(faultOf(fell)),
  });

  const columns: Column<HeldPunch>[] = [
    ...personColumns<HeldPunch>(t("punchWho"), t("department"), common("empty")),
    {
      id: "punch",
      header: t("punchAt"),
      card: (row) => stamp(row.ts),
      cell: (row) => <span className="whitespace-nowrap tabular-nums">{stamp(row.ts)}</span>,
    },
    { id: "hold", header: t("punchHold"), cell: (row) => <StatePill tone="waiting">{t(`hold${row.hold}`)}</StatePill> },
    {
      id: "heard",
      header: t("punchHeard"),
      priority: 2,
      cell: (row) => <span className="whitespace-nowrap tabular-nums">{stamp(row.receivedAt)}</span>,
    },
    { id: "waited", header: t("waitedHeader"), numeric: true, cell: (row) => <Waited count={row.waitedDays} /> },
  ];

  return (
    <>
      <DataTable
        id="inbox-punches"
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
              {t("punchBulkApprove", { count: chosen.length })}
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
              {t("punchBulkReject", { count: chosen.length })}
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
        title={t("punchTitle")}
        approveLabel={t("punchApprove")}
        busy={decide.mutation.isPending}
        fault={decide.fault}
        onApprove={(note) => open && decide.mutation.mutate({ id: open.id, approve: true, note, name: open.employee.fullName })}
        onReject={(note) => open && decide.mutation.mutate({ id: open.id, approve: false, note, name: open.employee.fullName })}
      >
        {open ? (
          <div className="flex flex-col gap-4">
            <Facts
              rows={[
                [t("punchAt"), `${stamp(open.ts)} · ${a(`direction${open.direction}`)}`],
                [t("punchDevice"), open.deviceId],
                [t("punchHeard"), stamp(open.receivedAt)],
                [t("punchHold"), t(`hold${open.hold}`)],
              ]}
            />
            <p className="text-kumo-subtle">{t(`hold${open.hold}Lead`)}</p>
          </div>
        ) : null}
      </DecisionSheet>

      <LayerDialog.Alert open={bulk !== null} onOpenChange={(next) => !next && setBulk(null)} dismissDisabled={many.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>
            {bulk?.approve ? t("punchBulkApproveTitle", { count: bulk.ids.length }) : t("punchBulkRejectTitle", { count: bulk?.ids.length ?? 0 })}
          </LayerDialog.Title>
          <LayerDialog.Description>{bulk?.approve ? t("punchBulkApproveLead") : t("punchBulkRejectLead")}</LayerDialog.Description>
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
              {bulk?.approve ? t("punchBulkApprove", { count: bulk.ids.length }) : t("punchBulkReject", { count: bulk?.ids.length ?? 0 })}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </>
  );
}

/** Letters asked for: the desk's queue, or every letter in the register. */
export function LettersQueue({ params, filtered, ledger, order, ...link }: QueueProps) {
  const t = useTranslations("requests");
  const c = useTranslations("certificates");
  const common = useTranslations("common");
  const format = useFormatter();
  const notify = useNotify();
  const handled = useHandled();
  const waiting = useWaiting();
  const inbox = useInboxLink();
  const asked = useQueue<Letter>(
    ["certificates", ledger ? "ledger" : "queue"],
    "/certificates",
    ledger ? params : { ...params, state: "REQUESTED" },
  );
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
  useReadSubject("CERTIFICATE", open?.id);
  const said = (row: Letter): Said | null =>
    !row.state || row.state === "REQUESTED"
      ? null
      : row.state === "CANCELLED"
        ? { key: "handledWithdrawn" }
        : { key: row.state === "ISSUED" ? "handledISSUED" : "handledREJECTED", who: row.decidedByName, at: row.issuedAt ?? row.updatedAt, note: row.note };
  const kindOf = (row: Letter) => (row.kind === "INCOME" && row.months ? `${c(row.kind)} · ${c("monthsN", { count: row.months })}` : c(row.kind));
  const ledgerColumns = useLedgerColumns<Letter>(
    (row) => row.createdAt,
    (row) => <StatePill tone={LETTER_TONE[row.state ?? "REQUESTED"]}>{c(row.state ?? "REQUESTED")}</StatePill>,
    (row) => ({ name: row.decidedByName, at: row.state === "ISSUED" ? row.issuedAt : row.state === "REJECTED" ? row.updatedAt : null }),
  );
  const columns: Column<Letter>[] = [
    ...personColumns<Letter>(t("who"), t("department"), common("empty")),
    { id: "kind", header: c("kind"), cell: kindOf },
    { id: "purpose", header: c("purpose"), priority: 3, truncate: true, cell: (row) => row.purpose },
    ...(ledger
      ? ledgerColumns
      : [{ id: "waited", header: t("waitedHeader"), numeric: true, cell: (row: Letter) => <Waited count={waitedSince(row)} /> }]),
  ];
  return (
    <>
      <DataTable
        {...sortedLedger(ledger ? order : undefined)}
        id={ledger ? "register-letters" : "inbox-letters"}
        columns={columns}
        rows={rows}
        keyOf={(row) => row.id}
        pending={asked.isPending}
        failed={asked.isError}
        onRetry={() => void asked.refetch()}
        empty={filtered ? t("queueNoMatch") : ledger ? t("ledgerEmpty") : t("queueEmpty")}
        cardLead="person"
        cardTrailing={ledger ? "state" : "waited"}
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
        handled={open ? (handled(said(open)) ?? (ledger ? waiting(inbox("certificates", open.id)) : undefined)) : undefined}
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

/** Changes to a record asked for: the desk's queue, or every change in the register. */
export function ChangesQueue({ params, filtered, ledger, order, ...link }: QueueProps) {
  const t = useTranslations("requests");
  const p = useTranslations("profile");
  const common = useTranslations("common");
  const notify = useNotify();
  const handled = useHandled();
  const waiting = useWaiting();
  const inbox = useInboxLink();
  const asked = useQueue<Change>(
    ["profile-changes", ledger ? "ledger" : "queue"],
    "/profile-changes",
    ledger ? params : { ...params, state: "PENDING" },
  );
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
  useReadSubject("PROFILE_CHANGE", open?.id);
  const said = (row: Change): Said | null =>
    !row.state || row.state === "PENDING"
      ? null
      : row.state === "CANCELLED"
        ? { key: "handledWithdrawn" }
        : { key: `handled${row.state}`, who: row.decidedByName, at: row.decidedAt, note: row.note };
  const ledgerColumns = useLedgerColumns<Change>(
    (row) => row.createdAt,
    (row) => <StatePill tone={CHANGE_TONE[row.state ?? "PENDING"]}>{p(`state${row.state ?? "PENDING"}`)}</StatePill>,
    (row) => ({ name: row.decidedByName, at: row.decidedAt }),
  );
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
    ...(ledger
      ? ledgerColumns
      : [{ id: "waited", header: t("waitedHeader"), numeric: true, cell: (row: Change) => <Waited count={waitedSince(row)} /> }]),
  ];
  return (
    <>
      <DataTable
        {...sortedLedger(ledger ? order : undefined)}
        id={ledger ? "register-changes" : "inbox-changes"}
        columns={columns}
        rows={rows}
        keyOf={(row) => row.id}
        pending={asked.isPending}
        failed={asked.isError}
        onRetry={() => void asked.refetch()}
        empty={filtered ? t("queueNoMatch") : ledger ? t("ledgerEmpty") : t("queueEmpty")}
        cardLead="person"
        cardTrailing={ledger ? "state" : "waited"}
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
        handled={open ? (handled(said(open)) ?? (ledger ? waiting(inbox("profileChanges", open.id)) : undefined)) : undefined}
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

/** Payslip disputes: the pay desk's queue, or every dispute in the register. */
export function DisputesQueue({ params, filtered, ledger, order, ...link }: QueueProps) {
  const t = useTranslations("requests");
  const d = useTranslations("disputes");
  const common = useTranslations("common");
  const format = useFormatter();
  const optional = useOptional();
  const lineName = useLineName();
  const notify = useNotify();
  const handled = useHandled();
  const waiting = useWaiting();
  const inbox = useInboxLink();
  const asked = useQueue<Claim>(
    ["payslip-disputes", ledger ? "ledger" : "queue"],
    "/payslip-disputes",
    ledger ? params : { ...params, state: "OPEN" },
  );
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
  useReadSubject("DISPUTE", open?.id);
  const said = (row: Claim): Said | null =>
    !row.state || row.state === "OPEN"
      ? null
      : row.state === "WITHDRAWN"
        ? { key: "handledWithdrawn" }
        : { key: row.outcome === "UPHELD" ? "handledUPHELD" : "handledREJECTED", who: row.decidedByName, at: row.answeredAt, note: row.answer };
  const closed = open ? said(open) : null;
  const deciding = open !== null && closed === null && !ledger;
  const ledgerColumns = useLedgerColumns<Claim>(
    (row) => row.createdAt,
    (row) => <StatePill tone={CLAIM_TONE[row.state ?? "OPEN"]}>{d(`state${row.state ?? "OPEN"}`)}</StatePill>,
    (row) => ({ name: row.decidedByName, at: row.answeredAt }),
  );
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
    ...(ledger
      ? ledgerColumns
      : [
          {
            id: "due",
            header: d("due"),
            priority: 2 as const,
            cell: (row: Claim) =>
              late(row) ? <StatePill tone="bad">{d("overdue")}</StatePill> : format.dateTime(new Date(row.dueAt), "day"),
          },
          { id: "waited", header: t("waitedHeader"), numeric: true, cell: (row: Claim) => <Waited count={waitedSince(row)} /> },
        ]),
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
        {...sortedLedger(ledger ? order : undefined)}
        id={ledger ? "register-disputes" : "inbox-disputes"}
        columns={columns}
        rows={rows}
        keyOf={(row) => row.id}
        pending={asked.isPending}
        failed={asked.isError}
        onRetry={() => void asked.refetch()}
        empty={filtered ? t("queueNoMatch") : ledger ? t("ledgerEmpty") : t("queueEmpty")}
        cardLead="person"
        cardTrailing={ledger ? "state" : "waited"}
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
                {closed ? handled(closed) : ledger ? waiting(inbox("disputes", open.id)) : null}
                {!deciding ? null : (
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
          {!deciding ? null : (
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

/** Salary advances: the desk's queue to decide or to pay, or every advance in the register. */
export function AdvancesQueue({ params, filtered, paying, ledger, order, ...link }: QueueProps & { paying: boolean }) {
  const t = useTranslations("requests");
  const pay = useTranslations("payroll");
  const common = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();
  const notify = useNotify();
  const handled = useHandled();
  const waiting = useWaiting();
  const inbox = useInboxLink();
  const asked = useQueue<Advance>(
    ["advances", ledger ? "ledger" : "queue", paying ? "pay" : "decide"],
    "/advances",
    ledger ? params : { ...params, state: paying ? "APPROVED" : "PENDING" },
  );
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
  useReadSubject("ADVANCE", open?.id);
  const said = (row: Advance): Said | null => {
    if (!row.state || row.state === (paying ? "APPROVED" : "PENDING")) {
      return null;
    }
    if (row.state === "PAID" || row.state === "SETTLED") {
      return paying || ledger
        ? { key: "handledPAID", at: row.paidAt }
        : { key: "handledAPPROVED", who: row.decidedByName, at: row.decidedAt, note: row.decisionNote };
    }
    if (row.state === "APPROVED" || row.state === "REJECTED") {
      return { key: `handled${row.state}`, who: row.decidedByName, at: row.decidedAt, note: row.decisionNote };
    }
    return { key: "handledWithdrawn" };
  };
  const closed = open ? said(open) : null;
  const ledgerColumns = useLedgerColumns<Advance>(
    (row) => row.requestedAt,
    (row) => <StatePill tone={ADVANCE_TONE[row.state ?? "PENDING"]}>{pay(`advance${row.state ?? "PENDING"}`)}</StatePill>,
    (row) => ({ name: row.decidedByName, at: row.decidedAt }),
  );
  const columns: Column<Advance>[] = [
    ...personColumns<Advance>(t("who"), t("department"), common("empty")),
    { id: "amount", header: pay("advanceAmount"), numeric: true, cell: (row) => cash(row.amount) },
    ...(ledger
      ? []
      : paying
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
    ...(ledger
      ? ledgerColumns
      : [{ id: "waited", header: t("waitedHeader"), numeric: true, cell: (row: Advance) => <Waited count={row.waitedDays} /> }]),
  ];
  return (
    <>
      <DataTable
        {...sortedLedger(ledger ? order : undefined)}
        id={ledger ? "register-advances" : paying ? "inbox-to-pay" : "inbox-advances"}
        columns={columns}
        rows={rows}
        keyOf={(row) => row.id}
        pending={asked.isPending}
        failed={asked.isError}
        onRetry={() => void asked.refetch()}
        empty={filtered ? t("queueNoMatch") : ledger ? t("ledgerEmpty") : t("queueEmpty")}
        cardLead="person"
        cardTrailing={ledger ? "state" : "amount"}
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
          handled={closed ? handled(closed) : ledger && open ? waiting(inbox("advancesToDecide", open.id)) : undefined}
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

/** Dependants registered for tax relief: the desk's queue, or every registration in the register. */
export function DependentsQueue({ params, filtered, ledger, order, ...link }: QueueProps) {
  const t = useTranslations("requests");
  const me = useTranslations("me");
  const common = useTranslations("common");
  const format = useFormatter();
  const notify = useNotify();
  const handled = useHandled();
  const waiting = useWaiting();
  const inbox = useInboxLink();
  const asked = useQueue<Dependent>(
    ["dependents", ledger ? "ledger" : "queue"],
    "/dependents",
    ledger ? params : { ...params, state: "PENDING" },
  );
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
  useReadSubject("DEPENDENT", open?.id);
  const said = (row: Dependent): Said | null =>
    !row.state || row.state === "PENDING"
      ? null
      : { key: row.state === "REJECTED" ? "handledREJECTED" : "handledAPPROVED", who: row.decidedByName, at: row.decidedAt, note: row.decisionNote };
  const ledgerColumns = useLedgerColumns<Dependent>(
    (row) => row.createdAt,
    (row) => <StatePill tone={DEPENDENT_TONE[row.state ?? "PENDING"]}>{me(`dependentState${row.state ?? "PENDING"}`)}</StatePill>,
    (row) => ({ name: row.decidedByName, at: row.decidedAt }),
  );
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
    ...(ledger
      ? ledgerColumns
      : [{ id: "waited", header: t("waitedHeader"), numeric: true, cell: (row: Dependent) => <Waited count={waitedSince(row)} /> }]),
  ];
  return (
    <>
      <DataTable
        {...sortedLedger(ledger ? order : undefined)}
        id={ledger ? "register-dependents" : "inbox-dependents"}
        columns={columns}
        rows={rows}
        keyOf={(row) => row.id}
        pending={asked.isPending}
        failed={asked.isError}
        onRetry={() => void asked.refetch()}
        empty={filtered ? t("queueNoMatch") : ledger ? t("ledgerEmpty") : t("queueEmpty")}
        cardLead="person"
        cardTrailing={ledger ? "state" : "waited"}
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
        handled={open ? (handled(said(open)) ?? (ledger ? waiting(inbox("dependents", open.id)) : undefined)) : undefined}
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
