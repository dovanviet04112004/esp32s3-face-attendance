"use client";

import { Button, Input } from "@cloudflare/kumo";
import { FloppyDiskIcon, XIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { useNotify } from "@/components/ui/notify";
import { PersonPicker } from "@/components/ui/person-picker";
import { StatePill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { money } from "@/lib/format";

interface Item {
  employeeId: number;
  fullName: string;
  code: string;
  amount: string;
}

interface Sheet {
  lineCode: string;
  items: Item[];
}

interface Loaded {
  employeeId: number;
  code: string;
  amount: string;
  employee: { id: number; code: string; fullName: string };
}

const kStore = "bonus-sheet:";
const kFresh: Sheet = { lineCode: "TET", items: [] };

function recall(key: string): Sheet | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? { ...kFresh, ...(JSON.parse(raw) as Partial<Sheet>) } : null;
  } catch {
    return null;
  }
}

function remember(key: string, sheet: Sheet): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(sheet));
  } catch {
    return;
  }
}

function forget(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    return;
  }
}

function valid(amount: string): boolean {
  const value = Number(amount);
  return amount.trim() !== "" && Number.isInteger(value) && value > 0;
}

function same(left: Sheet, right: Sheet): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sheetOf(loaded: Loaded[]): Sheet {
  return {
    lineCode: loaded[0]?.code ?? kFresh.lineCode,
    items: loaded.map((one) => ({
      employeeId: one.employeeId,
      code: one.employee.code,
      fullName: one.employee.fullName,
      amount: String(Math.trunc(Number(one.amount))),
    })),
  };
}

/** The amounts a bonus run pays: a decision somebody made, so it is typed here
 *  (KEHOACH 9.18). What the run holds is read back from the api; the draft
 *  being typed stays in the browser, apart from every query, until it is loaded.
 */
export function BonusSheet({ runId, editable }: { runId: string; editable: boolean }) {
  const t = useTranslations("payroll");
  const locale = useLocale();
  const notify = useNotify();
  const cache = useQueryClient();
  const draftKey = `${kStore}${runId}:draft`;
  const [draft, setDraftState] = useState<Sheet>(kFresh);
  const [amount, setAmount] = useState("");

  const loaded = useQuery({
    queryKey: ["payroll-runs", runId, "bonus"],
    queryFn: async () => sheetOf((await api.get<Loaded[]>(`/payroll-runs/${runId}/bonus`)).data),
  });
  const saved = loaded.data ?? null;

  // Storage is read after mount and after the run is read back, so an unsaved draft wins over both.
  useEffect(() => {
    if (loaded.isSuccess) {
      setDraftState(recall(draftKey) ?? loaded.data);
    }
  }, [draftKey, loaded.isSuccess, loaded.data]);

  function setDraft(next: Sheet): void {
    setDraftState(next);
    remember(draftKey, next);
  }

  const load = useMutation({
    mutationFn: async (sheet: Sheet) =>
      (
        await api.post<{ items: number }>(`/payroll-runs/${runId}/bonus`, {
          items: sheet.items.map((one) => ({ employeeId: one.employeeId, code: sheet.lineCode, amount: Number(one.amount) })),
        })
      ).data,
    onSuccess: (done) => {
      forget(draftKey);
      notify.done(t("bonusLoaded", { count: done.items }));
      void cache.invalidateQueries({ queryKey: ["payroll-runs", runId, "bonus"] });
    },
    onError: notify.failed,
  });

  function put(person: { id: number; code: string; fullName: string } | null): void {
    if (!person || draft.items.some((one) => one.employeeId === person.id)) {
      return;
    }
    setDraft({
      ...draft,
      items: [...draft.items, { employeeId: person.id, code: person.code, fullName: person.fullName, amount }],
    });
  }

  function retype(employeeId: number, next: string): void {
    setDraft({
      ...draft,
      items: draft.items.map((one) => (one.employeeId === employeeId ? { ...one, amount: next } : one)),
    });
  }

  const total = draft.items.reduce((sum, one) => sum + (valid(one.amount) ? Number(one.amount) : 0), 0);
  const dirty = !same(draft, saved ?? kFresh);
  const ready = draft.items.length > 0 && draft.items.every((one) => valid(one.amount)) && draft.lineCode.trim() !== "";

  return (
    <div className="flex flex-col gap-4 border-t border-kumo-hairline pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 font-semibold">{t("bonusTitle")}</h3>
        {dirty ? (
          <StatePill tone="waiting">{t("unsaved")}</StatePill>
        ) : saved && saved.items.length > 0 ? (
          <StatePill tone="good">{t("bonusInRun", { count: saved.items.length })}</StatePill>
        ) : null}
      </div>
      <p className="text-pretty text-kumo-subtle">{t("bonusLead")}</p>

      {editable ? (
        <div className="grid items-start gap-3 sm:grid-cols-2">
          <Input
            label={t("bonusCode")}
            maxLength={32}
            value={draft.lineCode}
            onChange={(event) => setDraft({ ...draft, lineCode: event.target.value.toUpperCase() })}
            className="w-full min-w-0"
          />
          <Input
            label={t("bonusAmount")}
            type="number"
            inputMode="numeric"
            min={0}
            value={amount}
            description={valid(amount) ? money(Number(amount), locale) : t("bonusAmountHint")}
            onChange={(event) => setAmount(event.target.value)}
            className="w-full min-w-0 tabular-nums"
          />
          <div className="min-w-0 sm:col-span-2">
            <PersonPicker label={t("bonusWho")} value={null} onChange={put} />
          </div>
        </div>
      ) : null}

      {draft.items.length === 0 ? (
        <p className="text-kumo-subtle">{t("bonusEmpty")}</p>
      ) : (
        <ul className="flex flex-col">
          {draft.items.map((one) => (
            <li
              key={one.employeeId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-kumo-hairline py-2 last:border-0"
            >
              <span className="flex min-w-40 flex-1 items-baseline gap-2">
                <span className="truncate">{one.fullName}</span>
                <span className="shrink-0 font-mono text-sm text-kumo-subtle">{one.code}</span>
              </span>
              {editable ? (
                <>
                  {valid(one.amount) ? (
                    <span className="text-sm text-kumo-subtle tabular-nums">{money(Number(one.amount), locale)}</span>
                  ) : null}
                  <Input
                    aria-label={t("bonusAmountFor", { name: one.fullName })}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={one.amount}
                    variant={valid(one.amount) ? "default" : "error"}
                    onChange={(event) => retype(one.employeeId, event.target.value)}
                    className="w-36 text-end tabular-nums"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    shape="square"
                    icon={XIcon}
                    aria-label={t("bonusDrop", { name: one.fullName })}
                    onClick={() => setDraft({ ...draft, items: draft.items.filter((row) => row.employeeId !== one.employeeId) })}
                  />
                </>
              ) : (
                <span className="tabular-nums">{money(Number(one.amount), locale)}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {draft.items.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p>
            {t("bonusTotal")} <span className="font-semibold tabular-nums">{money(total, locale)}</span>
            <span className="text-kumo-subtle"> · {t("bonusPeople", { count: draft.items.length })}</span>
          </p>
          {editable ? (
            <Button
              variant="secondary"
              icon={FloppyDiskIcon}
              loading={load.isPending}
              disabled={!ready || !dirty}
              onClick={() => load.mutate(draft)}
            >
              {t("bonusSave")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
