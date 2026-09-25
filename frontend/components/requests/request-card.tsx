"use client";

import { Banner, Button, LayerCard, Textarea } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { useOptional } from "@/components/ui/optional";
import { StatePill as Pill, type Tone } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { dayOnly, days, minutes } from "@/lib/format";

export type RequestKind =
  | "LEAVE"
  | "OVERTIME"
  | "ATTENDANCE_FIX"
  | "BUSINESS_TRIP"
  | "REMOTE_WORK";

export type RequestState = "DRAFT" | "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

export type DayPart = "MORNING" | "AFTERNOON";

export interface Person {
  id: number;
  code: string;
  fullName: string;
  department?: { id: string; name: string } | null;
}

export interface RequestRow {
  id: string;
  kind: RequestKind;
  state: RequestState;
  fromDate: string;
  toDate: string;
  fromAt?: string | null;
  toAt?: string | null;
  halfDay?: boolean;
  dayPart?: DayPart | null;
  days: string;
  minutes: number;
  reason: string;
  createdAt: string;
  decidedAt?: string | null;
  decisionNote: string | null;
  employee: Person | null;
  leaveType: { id: string; code: string; name: string } | null;
  decidedBy?: { id: string; email: string; fullName: string | null } | null;
}

export interface InboxRow extends RequestRow {
  waitedDays: number;
  balanceAfter: number | null;
  overlapCount: number | null;
}

export interface LeaveBalance {
  leaveTypeId: string;
  code: string;
  name: string;
  year: number;
  entitled: number;
  carriedOver: number;
  taken: number;
  pending: number;
  remaining: number;
}

export interface Overlap {
  id: string;
  fromDate: string;
  toDate: string;
  state: RequestState;
  employee: Person;
}

export interface RequestDetail extends RequestRow {
  balance: LeaveBalance | null;
  overlapping: Overlap[];
  mayDecide: boolean;
}

const TONE: Record<RequestState, Tone> = {
  DRAFT: "idle",
  PENDING: "waiting",
  APPROVED: "good",
  REJECTED: "bad",
  CANCELLED: "idle",
};

const kNoteMax = 500;

export function StatePill({ state }: { state: RequestState }) {
  const t = useTranslations("requests");
  return <Pill tone={TONE[state]}>{t(`state${state}`)}</Pill>;
}

/** Somebody's leave balances in the year a day falls in, as the api computes them.
 *  @param asOf YYYY-MM-DD; the balance year is read from it.
 */
export function useLeaveBalances(employeeId: number | undefined, asOf: string, enabled = true) {
  return useQuery({
    queryKey: ["leave-balances", employeeId, asOf.slice(0, 4)],
    enabled: enabled && employeeId !== undefined,
    queryFn: async () =>
      (await api.get<LeaveBalance[]>(`/leave-balances?employeeId=${employeeId}&asOf=${asOf.slice(0, 10)}`)).data,
  });
}

/** One request put into words: its kind, its dates and how much of the day it takes. */
export function useRequestWords() {
  const t = useTranslations("requests");
  const format = useFormatter();
  const locale = useLocale();
  const clock = (iso: string) => format.dateTime(new Date(iso), { hour: "2-digit", minute: "2-digit" });
  return {
    kind: (row: Pick<RequestRow, "kind" | "leaveType">) =>
      row.leaveType ? `${t(`kind${row.kind}`)} · ${row.leaveType.name}` : t(`kind${row.kind}`),
    span: (row: Pick<RequestRow, "fromDate" | "toDate">) => {
      const from = format.dateTime(dayOnly(row.fromDate), "day");
      return row.fromDate.slice(0, 10) === row.toDate.slice(0, 10) ? from : `${from} → ${format.dateTime(dayOnly(row.toDate), "day")}`;
    },
    extent: (row: RequestRow) => {
      if (row.kind === "ATTENDANCE_FIX" && (row.fromAt || row.toAt)) {
        return [row.fromAt ? t("fixIn", { time: clock(row.fromAt) }) : null, row.toAt ? t("fixOut", { time: clock(row.toAt) }) : null]
          .filter(Boolean)
          .join(" · ");
      }
      if (row.fromAt && row.toAt) {
        return `${clock(row.fromAt)} – ${clock(row.toAt)}`;
      }
      if (row.minutes > 0) {
        return minutes(row.minutes, locale);
      }
      if (row.halfDay && row.dayPart) {
        return t(`dayPart${row.dayPart}`);
      }
      return days(Number(row.days), locale);
    },
  };
}

function Fact({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex justify-between gap-3 border-b border-kumo-hairline py-2 last:border-0 sm:block sm:border-0 sm:py-0",
        wide && "sm:col-span-2",
      )}
    >
      <dt className="text-sm text-kumo-subtle">{label}</dt>
      <dd className="text-end sm:text-start">{children}</dd>
    </div>
  );
}

export interface Decision {
  rejecting: boolean;
  note: string;
  missing: boolean;
  setNote: (next: string) => void;
  startReject: () => void;
  back: () => void;
  /** Sends the decision where it stands; turning down waits until it has a reason. */
  send: (onApprove: (note: string) => void, onReject?: (reason: string) => void) => void;
}

/** Where a decision stands: approving by default, turning down only once asked (KEHOACH 9.10). */
export function useDecision(): Decision {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNoteHeld] = useState("");
  const [missing, setMissing] = useState(false);
  return {
    rejecting,
    note,
    missing,
    setNote: (next) => {
      setNoteHeld(next);
      setMissing(false);
    },
    startReject: () => setRejecting(true),
    back: () => {
      setRejecting(false);
      setMissing(false);
    },
    send: (onApprove, onReject) => {
      if (!rejecting) {
        onApprove(note.trim());
      } else if (note.trim() === "") {
        setMissing(true);
      } else {
        onReject?.(note.trim());
      }
    },
  };
}

/** The note box, the reason box and the server's answer, at the end of a decision's body. */
export function DecisionFields({
  decision,
  fault,
  noteOnApprove,
  mayReject,
  busy,
}: {
  decision: Decision;
  fault: string | null;
  noteOnApprove?: boolean;
  mayReject: boolean;
  busy: boolean;
}) {
  const t = useTranslations("requests");
  const optional = useOptional();
  return (
    <div className="mt-4 flex flex-col gap-3">
      {decision.rejecting ? (
        <Textarea
          label={t("rejectReason")}
          autoFocus
          rows={3}
          maxLength={kNoteMax}
          value={decision.note}
          error={decision.missing ? t("reasonNeeded") : undefined}
          variant={decision.missing ? "error" : "default"}
          onValueChange={decision.setNote}
        />
      ) : noteOnApprove ? (
        <div className="hidden md:block">
          <Textarea
            label={optional(t("note"))}
            description={t("noteReadable")}
            rows={2}
            maxLength={kNoteMax}
            value={decision.note}
            onValueChange={decision.setNote}
          />
        </div>
      ) : null}
      {fault ? <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null}
      {mayReject ? (
        decision.rejecting ? (
          <Button variant="ghost" icon={ArrowCounterClockwiseIcon} disabled={busy} className="self-start" onClick={decision.back}>
            {t("rejectBack")}
          </Button>
        ) : (
          <Button variant="secondary-destructive" icon={XIcon} disabled={busy} className="self-start" onClick={decision.startReject}>
            {t("reject")}
          </Button>
        )
      ) : null}
    </div>
  );
}

/** A request's facts as label and value, the same on a card, a sheet and a record page. */
export function RequestFacts({ row, extra }: { row: RequestRow; extra?: [string, ReactNode][] }) {
  const t = useTranslations("requests");
  const words = useRequestWords();
  const format = useFormatter();
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
      <Fact label={t("range")} wide>
        {words.span(row)}
      </Fact>
      <Fact label={t("extent")}>
        <span className="tabular-nums">{words.extent(row)}</span>
      </Fact>
      <Fact label={t("filed")}>{format.dateTime(new Date(row.createdAt), "day")}</Fact>
      {(extra ?? []).map(([label, value]) => (
        <Fact key={label} label={label}>
          {value}
        </Fact>
      ))}
    </dl>
  );
}

interface Props {
  row: RequestRow;
  onCancel?: () => void;
  busy?: boolean;
  /** What heads the card: the requester, or the request kind on a list of one's own requests. */
  titleBy?: "employee" | "kind";
  /** Below the facts: what a record page adds, such as the decision. */
  children?: ReactNode;
}

/** One request read in full; deciding it happens in the inbox sheet or on its record page (KEHOACH 9.15). */
export function RequestCard({ row, onCancel, busy, titleBy = "employee", children }: Props) {
  const t = useTranslations("requests");
  const format = useFormatter();
  const words = useRequestWords();
  const byKind = titleBy === "kind" || !row.employee;
  const title = byKind ? words.kind(row) : (row.employee?.fullName ?? words.kind(row));
  const decided =
    row.decidedAt && row.state !== "PENDING" && row.state !== "CANCELLED"
      ? t("decidedOn", {
          date: format.dateTime(new Date(row.decidedAt), "day"),
          who: row.decidedBy?.fullName ?? row.decidedBy?.email ?? "none",
        })
      : null;

  return (
    <LayerCard className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{title}</p>
          {byKind ? null : <p className="text-sm text-kumo-subtle">{words.kind(row)}</p>}
        </div>
        <StatePill state={row.state} />
      </div>
      <div className="mt-3">
        <RequestFacts row={row} />
      </div>
      <p className="mt-3 break-words">{row.reason}</p>
      {decided ? <p className="mt-3 text-sm text-kumo-subtle">{decided}</p> : null}
      {row.decisionNote ? <p className="mt-1 rounded-lg bg-kumo-tint p-3 break-words">{row.decisionNote}</p> : null}
      {children}
      {onCancel && row.state === "PENDING" ? (
        <Button variant="secondary-destructive" loading={busy} onClick={onCancel} className="mt-4">
          {t("cancel")}
        </Button>
      ) : null}
    </LayerCard>
  );
}
