"use client";

import { Button, Input, LayerCard } from "@cloudflare/kumo";
import { useFormatter, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { useLineName } from "@/components/payroll/payslip-view";
import { StatePill } from "@/components/ui/pill";
import { cn } from "@/lib/cn";

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
    <li>
      <LayerCard className="flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium">{dispute.lineCode ? nameOf(dispute.lineCode) : t("lineAny")}</span>
          <StatePill tone={dispute.state === "OPEN" ? "waiting" : "idle"}>{t(`state${dispute.state}`)}</StatePill>
          {dispute.outcome ? (
            <StatePill tone={dispute.outcome === "UPHELD" ? "good" : "bad"}>{t(`outcome${dispute.outcome}`)}</StatePill>
          ) : null}
          <span className={cn("ms-auto text-sm", late ? "text-kumo-danger" : "text-kumo-subtle")}>
            {late ? t("overdue") : t("due")}: {format.dateTime(new Date(dispute.dueAt), "day")}
          </span>
        </div>

        <p>{dispute.claim}</p>

        {dispute.employee ? (
          <p className="text-sm text-kumo-subtle">
            {t("person")}: {dispute.employee.code} · {dispute.employee.fullName}
          </p>
        ) : null}

        {dispute.answer ? <p className="rounded-lg bg-kumo-tint p-3">{dispute.answer}</p> : null}

        {dispute.retroId ? <p className="text-sm text-kumo-success">{t("paid")}</p> : null}

        {dispute.state === "OPEN" && mayAnswer ? (
          <form className="mt-2 flex flex-col gap-3" onSubmit={(event) => send("UPHELD", event)}>
            <Input
              label={t("answer")}
              required
              value={answer}
              placeholder={t("answerHint")}
              onChange={(event) => setAnswer(event.target.value)}
            />
            <Input
              label={t("amount")}
              type="number"
              min={1}
              value={amount}
              description={t("amountHint")}
              onChange={(event) => setAmount(event.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="secondary" loading={busy} disabled={answer.trim() === ""}>
                {t("uphold")}
              </Button>
              <Button
                type="button"
                variant="secondary-destructive"
                disabled={busy || answer.trim() === ""}
                onClick={(event) => send("REJECTED", event)}
              >
                {t("turnDown")}
              </Button>
            </div>
          </form>
        ) : null}

        {dispute.state === "OPEN" && onWithdraw ? (
          <Button variant="secondary" className="mt-2 self-start" disabled={busy} onClick={() => onWithdraw(dispute.id)}>
            {t("withdraw")}
          </Button>
        ) : null}
      </LayerCard>
    </li>
  );
}
