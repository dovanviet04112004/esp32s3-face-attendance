"use client";

import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { StatePill, type Tone } from "@/components/ui/pill";
import { money } from "@/lib/format";

export type RunState = "DRAFT" | "RUNNING" | "DONE" | "FAILED" | "DISCARDED";
export type RunKind = "REGULAR" | "BONUS" | "FINAL_SETTLEMENT";

export interface PayrollRun {
  id: string;
  kind: RunKind;
  state: RunState;
  label: string | null;
  employeeCount: number;
  doneCount: number;
  failedCount: number;
  grossTotal: string;
  netTotal: string;
}

const TONE: Record<RunState, Tone> = {
  DRAFT: "idle",
  RUNNING: "waiting",
  DONE: "good",
  FAILED: "bad",
  DISCARDED: "idle",
};

const STATE_KEY: Record<
  RunState,
  "stateDRAFT" | "stateRUNNING" | "stateDONE" | "stateFAILED" | "stateDISCARDED"
> = {
  DRAFT: "stateDRAFT",
  RUNNING: "stateRUNNING",
  DONE: "stateDONE",
  FAILED: "stateFAILED",
  DISCARDED: "stateDISCARDED",
};

export function RunProgress({ run, action }: { run: PayrollRun; action?: ReactNode }) {
  const t = useTranslations("payroll");
  const locale = useLocale();
  const share = run.employeeCount === 0 ? 0 : run.doneCount / run.employeeCount;

  return (
    <article className="rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{run.label ?? t(`run${run.kind}`)}</p>
          <p className="mt-0.5 text-xs text-(--color-muted) tabular-nums">
            {run.doneCount} / {run.employeeCount} {t("employees")}
          </p>
        </div>
        <StatePill tone={TONE[run.state]}>{t(STATE_KEY[run.state])}</StatePill>
      </div>

      <div
        role="progressbar"
        aria-valuenow={Math.round(share * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-(--color-ground)"
      >
        <div
          className="h-full rounded-full bg-(--color-accent) transition-[width]"
          style={{ width: `${Math.round(share * 100)}%` }}
        />
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-3">
          <dt className="text-xs text-(--color-muted)">{t("gross")}</dt>
          <dd className="tabular-nums">{money(Number(run.grossTotal), locale)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-xs text-(--color-muted)">{t("net")}</dt>
          <dd className="tabular-nums">{money(Number(run.netTotal), locale)}</dd>
        </div>
      </dl>

      {action ? <div className="mt-4">{action}</div> : null}
    </article>
  );
}
