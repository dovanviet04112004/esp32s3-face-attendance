"use client";

import { LayerCard, Meter } from "@cloudflare/kumo";
import { useFormatter, useLocale, useTranslations } from "next-intl";
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

/** One run of a period: progress, totals, actions in the header strip; the
 *  inputs a bonus or settlement run pays from go in as children.
 */
export function RunProgress({ run, action, children }: { run: PayrollRun; action?: ReactNode; children?: ReactNode }) {
  const t = useTranslations("payroll");
  const format = useFormatter();
  const locale = useLocale();
  const kindName = t(`run${run.kind}`);
  const share = run.employeeCount === 0 ? 0 : run.doneCount / run.employeeCount;

  return (
    <LayerCard>
      <LayerCard.Secondary className="flex-wrap justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-medium text-kumo-default">{run.label ?? kindName}</span>
          {run.label ? <span>{kindName}</span> : null}
          <StatePill tone={TONE[run.state]}>{t(STATE_KEY[run.state])}</StatePill>
        </span>
        {action}
      </LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-4">
        <Meter
          label={t("runProgress")}
          value={Math.round(share * 100)}
          customValue={`${run.doneCount} / ${run.employeeCount} ${t("employees")}`}
        />
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-3">
          <div className="flex flex-col">
            <dt className="text-sm text-kumo-subtle">{t("gross")}</dt>
            <dd className="font-medium tabular-nums">{money(Number(run.grossTotal), locale)}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-sm text-kumo-subtle">{t("net")}</dt>
            <dd className="font-medium tabular-nums">{money(Number(run.netTotal), locale)}</dd>
          </div>
          {run.failedCount > 0 ? (
            <div className="flex flex-col">
              <dt className="text-sm text-kumo-subtle">{t("runFailedCount")}</dt>
              <dd className="font-medium text-kumo-danger tabular-nums">{format.number(run.failedCount)}</dd>
            </div>
          ) : null}
        </dl>
        {children}
      </LayerCard.Primary>
    </LayerCard>
  );
}
