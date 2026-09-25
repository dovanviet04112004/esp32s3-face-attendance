"use client";

import { Button, LayerCard, SkeletonLine, Textarea } from "@cloudflare/kumo";
import { CheckIcon, XIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useRef, useState, type ReactNode } from "react";

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

export interface RequestRow {
  id: string;
  kind: RequestKind;
  state: RequestState;
  fromDate: string;
  toDate: string;
  days: string;
  minutes: number;
  reason: string;
  createdAt: string;
  decisionNote: string | null;
  employee: { id: number; code: string; fullName: string } | null;
  leaveType: { id: string; code: string; name: string } | null;
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

const kDayMs = 86_400_000;

const TONE: Record<RequestState, Tone> = {
  DRAFT: "idle",
  PENDING: "waiting",
  APPROVED: "good",
  REJECTED: "bad",
  CANCELLED: "idle",
};

export function StatePill({ state }: { state: RequestState }) {
  const t = useTranslations("requests");
  return <Pill tone={TONE[state]}>{t(`state${state}`)}</Pill>;
}

/** Whole days between filing and now, which is what the sweep also counts. */
function waited(since: string): number {
  return Math.floor((Date.now() - new Date(since).getTime()) / kDayMs);
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

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 sm:block">
      <dt className="text-sm text-kumo-subtle">{label}</dt>
      <dd className="text-end sm:text-start">{children}</dd>
    </div>
  );
}

interface Props {
  row: RequestRow;
  /** Decide is only offered where the api would accept it. */
  onDecide?: (approve: boolean, note: string) => void;
  onCancel?: () => void;
  busy?: boolean;
  /** Show the requester's balance of the requested leave type where the decision is made (KEHOACH 9.10). */
  balance?: boolean;
  /** What heads the card: the requester, or the request kind on a list of one's own requests. */
  titleBy?: "employee" | "kind";
}

export function RequestCard({ row, onDecide, onCancel, busy, balance, titleBy = "employee" }: Props) {
  const t = useTranslations("requests");
  const common = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();
  const [note, setNote] = useState("");
  const [missing, setMissing] = useState(false);
  const [pressed, setPressed] = useState<"approve" | "reject" | null>(null);
  const noteField = useRef<HTMLTextAreaElement>(null);
  const showsBalance = balance === true && row.kind === "LEAVE" && row.leaveType !== null;
  const balances = useLeaveBalances(row.employee?.id, row.fromDate, showsBalance);
  const held = balances.data?.find((one) => one.leaveTypeId === row.leaveType?.id);

  const kind = row.leaveType ? `${t(`kind${row.kind}`)} · ${row.leaveType.name}` : t(`kind${row.kind}`);
  const byKind = titleBy === "kind" || !row.employee;
  const title = byKind ? kind : (row.employee?.fullName ?? kind);
  const detail = [
    byKind ? null : (row.leaveType?.name ?? t(`kind${row.kind}`)),
    row.minutes > 0 ? minutes(row.minutes, locale) : null,
  ].filter((one) => one !== null);

  const span =
    row.fromDate === row.toDate
      ? format.dateTime(dayOnly(row.fromDate), "day")
      : `${format.dateTime(dayOnly(row.fromDate), "day")} → ${format.dateTime(dayOnly(row.toDate), "day")}`;

  function decide(approve: boolean): void {
    if (!approve && note.trim() === "") {
      setMissing(true);
      noteField.current?.focus();
      return;
    }
    setMissing(false);
    setPressed(approve ? "approve" : "reject");
    onDecide?.(approve, note.trim());
  }

  return (
    <LayerCard className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{title}</p>
          {detail.length > 0 ? <p className="text-sm text-kumo-subtle">{detail.join(" · ")}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          {row.state === "PENDING" && waited(row.createdAt) > 0 ? (
            <Pill className="tabular-nums">{t("waited", { count: waited(row.createdAt) })}</Pill>
          ) : null}
          <StatePill state={row.state} />
        </div>
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-3">
        <Fact label={t("range")}>{span}</Fact>
        <Fact label={t("days")}>
          <span className="tabular-nums">{days(Number(row.days), locale)}</span>
        </Fact>
        {showsBalance && row.leaveType ? (
          <Fact label={t("balanceOf", { name: row.leaveType.name })}>
            {balances.isPending ? (
              <SkeletonLine minWidth={50} maxWidth={80} />
            ) : held ? (
              <span className={cn("tabular-nums", held.remaining < 0 && "text-kumo-danger")}>
                {t("balanceValue", { left: held.remaining, total: held.entitled + held.carriedOver })}
              </span>
            ) : (
              <span className="text-kumo-subtle">{balances.isError ? common("empty") : t("balanceNone")}</span>
            )}
          </Fact>
        ) : null}
      </dl>
      {held && held.pending > 0 && row.state === "PENDING" ? (
        <p className="mt-1 text-sm text-kumo-subtle">{t("balanceHeld", { count: held.pending })}</p>
      ) : null}

      <p className="mt-3">{row.reason}</p>
      {row.decisionNote ? <p className="mt-1 text-kumo-subtle">{row.decisionNote}</p> : null}

      {onDecide ? (
        <div className="mt-4 flex flex-col gap-3">
          <Textarea
            ref={noteField}
            label={t("note")}
            description={missing ? undefined : t("noteHint")}
            error={missing ? t("reasonNeeded") : undefined}
            variant={missing ? "error" : "default"}
            rows={2}
            maxLength={500}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
              setMissing(false);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              icon={CheckIcon}
              loading={busy && pressed === "approve"}
              disabled={busy}
              onClick={() => decide(true)}
            >
              {t("approve")}
            </Button>
            <Button
              variant="secondary-destructive"
              icon={XIcon}
              loading={busy && pressed === "reject"}
              disabled={busy}
              onClick={() => decide(false)}
            >
              {t("reject")}
            </Button>
          </div>
        </div>
      ) : null}

      {onCancel && row.state === "PENDING" ? (
        <Button variant="secondary-destructive" loading={busy} onClick={onCancel} className="mt-4">
          {t("cancel")}
        </Button>
      ) : null}
    </LayerCard>
  );
}
