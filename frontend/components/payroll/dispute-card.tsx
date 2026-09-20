"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLineName } from "@/components/payroll/payslip-view";

export interface Dispute {
  id: string;
  employeeId: number;
  payslipId: string;
  lineCode: string | null;
  claim: string;
  state: "OPEN" | "ANSWERED" | "WITHDRAWN";
  dueAt: string;
  outcome: "UPHELD" | "REJECTED" | null;
  answer: string | null;
  retroId: string | null;
  createdAt: string;
  employee?: { code: string; fullName: string };
}

export interface Verdict {
  id: string;
  outcome: "UPHELD" | "REJECTED";
  answer: string;
  amount?: number;
}

interface Props {
  dispute: Dispute;
  mayAnswer?: boolean;
  onAnswer?: (verdict: Verdict) => void;
  onWithdraw?: (id: string) => void;
  busy?: boolean;
}

export function DisputeCard({ dispute, mayAnswer, onAnswer, onWithdraw, busy }: Props) {
  const t = useTranslations("disputes");
  const format = useFormatter();
  const nameOf = useLineName();
  const [answer, setAnswer] = useState("");
  const [amount, setAmount] = useState("");

  const late = dispute.state === "OPEN" && new Date(dispute.dueAt).getTime() < Date.now();

  function send(outcome: Verdict["outcome"], event: FormEvent) {
    event.preventDefault();
    onAnswer?.({
      id: dispute.id,
      outcome,
      answer,
      ...(outcome === "UPHELD" && amount !== "" ? { amount: Number(amount) } : {}),
    });
  }

  return (
    <li className="rounded-xl border border-(--color-line) bg-(--color-surface) p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium">
          {dispute.lineCode ? nameOf(dispute.lineCode) : t("lineAny")}
        </span>
        <span className="rounded-full bg-(--color-ground) px-2 py-0.5 text-xs text-(--color-muted)">
          {t(`state${dispute.state}`)}
        </span>
        {dispute.outcome ? (
          <span
            className={[
              "rounded-full px-2 py-0.5 text-xs text-white",
              dispute.outcome === "UPHELD" ? "bg-(--color-accent)" : "bg-(--color-danger)",
            ].join(" ")}
          >
            {t(`outcome${dispute.outcome}`)}
          </span>
        ) : null}
        <span className={`ml-auto text-xs ${late ? "text-(--color-danger)" : "text-(--color-muted)"}`}>
          {late ? t("overdue") : t("due")}: {format.dateTime(new Date(dispute.dueAt), "day")}
        </span>
      </div>

      <p className="mt-1 text-sm">{dispute.claim}</p>

      {dispute.employee ? (
        <p className="mt-1 text-xs text-(--color-muted)">
          {t("person")}: {dispute.employee.code} · {dispute.employee.fullName}
        </p>
      ) : null}

      {dispute.answer ? (
        <p className="mt-2 rounded-lg bg-(--color-ground) p-2 text-sm">{dispute.answer}</p>
      ) : null}

      {dispute.retroId ? (
        <p className="mt-1 text-xs text-(--color-ok)">{t("paid")}</p>
      ) : null}

      {dispute.state === "OPEN" && mayAnswer ? (
        <form className="mt-3 flex flex-col gap-2" onSubmit={(event) => send("UPHELD", event)}>
          <label className="text-sm font-medium" htmlFor={`answer-${dispute.id}`}>
            {t("answer")}
          </label>
          <Input
            id={`answer-${dispute.id}`}
            required
            value={answer}
            placeholder={t("answerHint")}
            onChange={(event) => setAnswer(event.target.value)}
          />
          <label className="text-sm font-medium" htmlFor={`amount-${dispute.id}`}>
            {t("amount")}
          </label>
          <Input
            id={`amount-${dispute.id}`}
            type="number"
            min={1}
            value={amount}
            placeholder={t("amountHint")}
            onChange={(event) => setAmount(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {t("uphold")}
            </Button>
            <Button
              type="button"
              size="sm"
              tone="quiet"
              disabled={busy || answer.trim() === ""}
              onClick={(event) => send("REJECTED", event)}
            >
              {t("turnDown")}
            </Button>
          </div>
        </form>
      ) : null}

      {dispute.state === "OPEN" && onWithdraw ? (
        <Button
          size="sm"
          tone="quiet"
          className="mt-3"
          disabled={busy}
          onClick={() => onWithdraw(dispute.id)}
        >
          {t("withdraw")}
        </Button>
      ) : null}
    </li>
  );
}
