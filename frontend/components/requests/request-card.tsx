"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

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
  decisionNote: string | null;
  employee: { id: number; code: string; fullName: string } | null;
  leaveType: { id: string; code: string; name: string } | null;
}

const TONE: Record<RequestState, string> = {
  DRAFT: "border-(--color-line) text-(--color-muted)",
  PENDING: "border-(--color-warn) text-(--color-warn)",
  APPROVED: "border-(--color-ok) text-(--color-ok)",
  REJECTED: "border-(--color-danger) text-(--color-danger)",
  CANCELLED: "border-(--color-line) text-(--color-muted)",
};

/** A status reads as a word first and a colour second, so it survives a reader
 *  who cannot tell red from green (KEHOACH 9.12).
 */
export function StatePill({ state }: { state: RequestState }) {
  const t = useTranslations("requests");
  return (
    <span className={cn("rounded-full border px-2 py-0.5 text-xs", TONE[state])}>
      {t(`state${state}`)}
    </span>
  );
}

interface Props {
  row: RequestRow;
  /** Decide is only offered where the api would accept it. */
  onDecide?: (approve: boolean, note: string) => void;
  onCancel?: () => void;
  busy?: boolean;
}

export function RequestCard({ row, onDecide, onCancel, busy }: Props) {
  const t = useTranslations("requests");
  const common = useTranslations("common");
  const format = useFormatter();
  const [note, setNote] = useState("");

  const span =
    row.fromDate === row.toDate
      ? format.dateTime(new Date(row.fromDate), "day")
      : `${format.dateTime(new Date(row.fromDate), "day")} → ${format.dateTime(new Date(row.toDate), "day")}`;

  return (
    <article className="rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">
            {row.employee ? row.employee.fullName : t(`kind${row.kind}`)}
          </p>
          <p className="mt-0.5 text-xs text-(--color-muted)">
            {t(`kind${row.kind}`)}
            {row.leaveType ? ` · ${row.leaveType.name}` : ""}
            {row.minutes > 0 ? ` · ${row.minutes} ${t("minutes").toLowerCase()}` : ""}
          </p>
        </div>
        <StatePill state={row.state} />
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-3 sm:block">
          <dt className="text-xs text-(--color-muted)">{t("range")}</dt>
          <dd>{span}</dd>
        </div>
        <div className="flex justify-between gap-3 sm:block">
          <dt className="text-xs text-(--color-muted)">{t("days")}</dt>
          <dd className="tabular-nums">{Number(row.days)}</dd>
        </div>
      </dl>

      <p className="mt-3 text-sm">{row.reason}</p>
      {row.decisionNote ? (
        <p className="mt-1 text-sm text-(--color-muted)">{row.decisionNote}</p>
      ) : null}

      {onDecide ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Input
            aria-label={t("note")}
            placeholder={t("note")}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="min-w-40 flex-1"
          />
          <Button type="button" disabled={busy} onClick={() => onDecide(true, note)}>
            {t("approve")}
          </Button>
          <Button type="button" tone="danger" disabled={busy} onClick={() => onDecide(false, note)}>
            {t("reject")}
          </Button>
        </div>
      ) : null}

      {onCancel && row.state === "PENDING" ? (
        <Button
          type="button"
          tone="quiet"
          disabled={busy}
          onClick={onCancel}
          className="mt-4"
        >
          {busy ? common("saving") : t("cancel")}
        </Button>
      ) : null}
    </article>
  );
}
