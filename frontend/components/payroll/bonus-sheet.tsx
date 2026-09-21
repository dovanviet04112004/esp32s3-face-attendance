"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";
import { money } from "@/lib/format";

interface Person {
  id: number;
  code: string;
  fullName: string;
}

interface Item {
  employeeId: number;
  fullName: string;
  code: string;
  amount: string;
}

const SEARCH_MIN = 2;

/** The amounts a bonus run pays. Nothing is derivable here: a bonus is a
 *  decision somebody made, so the sheet is what carries it (KEHOACH 9.18).
 */
export function BonusSheet({ runId, editable }: { runId: string; editable: boolean }) {
  const t = useTranslations("payroll");
  const common = useTranslations("common");
  const locale = useLocale();
  const faultOf = useFault();

  const [items, setItems] = useState<Item[]>([]);
  const [search, setSearch] = useState("");
  const [code, setCode] = useState("TET");
  const [amount, setAmount] = useState("");
  const [fault, setFault] = useState<string | null>(null);

  const people = useQuery({
    queryKey: ["employees", "for-bonus", search],
    enabled: editable && search.length >= SEARCH_MIN,
    queryFn: async () =>
      (await api.get<{ rows: Person[] }>(`/employees?search=${encodeURIComponent(search)}&take=8`))
        .data.rows,
  });

  const load = useMutation({
    mutationFn: async () =>
      (
        await api.post<{ items: number }>(`/payroll-runs/${runId}/bonus`, {
          items: items.map((one) => ({
            employeeId: one.employeeId,
            code,
            amount: Number(one.amount),
          })),
        })
      ).data,
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function put(one: Person): void {
    if (items.some((row) => row.employeeId === one.id) || amount === "") {
      return;
    }
    setItems([...items, { employeeId: one.id, code: one.code, fullName: one.fullName, amount }]);
    setSearch("");
  }

  const total = items.reduce((sum, one) => sum + Number(one.amount), 0);

  return (
    <div className="rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
      <h3 className="text-sm font-medium">{t("bonusTitle")}</h3>
      <p className="mt-1 text-sm text-(--color-muted)">{t("bonusLead")}</p>

      {editable ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="w-32">
            <label className="block text-xs text-(--color-muted)" htmlFor="bonusCode">
              {t("bonusCode")}
            </label>
            <Input
              id="bonusCode"
              maxLength={32}
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              className="mt-1"
            />
          </div>
          <div className="w-40">
            <label className="block text-xs text-(--color-muted)" htmlFor="bonusAmount">
              {t("bonusAmount")}
            </label>
            <Input
              id="bonusAmount"
              type="number"
              inputMode="numeric"
              min={0}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="mt-1"
            />
            {amount !== "" && Number(amount) > 0 ? (
              <p className="mt-1 text-xs text-(--color-muted) tabular-nums">
                {money(Number(amount), locale)}
              </p>
            ) : null}
          </div>
          <div className="min-w-44 flex-1">
            <label className="block text-xs text-(--color-muted)" htmlFor="bonusWho">
              {t("bonusWho")}
            </label>
            <Input
              id="bonusWho"
              value={search}
              placeholder={t("bonusWhoHint")}
              onChange={(event) => setSearch(event.target.value)}
              className="mt-1"
            />
          </div>
        </div>
      ) : null}

      {(people.data ?? []).length > 0 ? (
        <ul className="mt-2 flex flex-col">
          {(people.data ?? []).map((one) => (
            <li
              key={one.id}
              className="flex items-center gap-3 border-b border-(--color-line) py-2 text-sm last:border-0"
            >
              <span className="min-w-0 flex-1 truncate">{one.fullName}</span>
              <span className="font-mono text-xs text-(--color-muted)">{one.code}</span>
              <Button type="button" size="sm" disabled={amount === ""} onClick={() => put(one)}>
                {t("bonusAdd")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {items.length > 0 ? (
        <>
          <ul className="mt-3 flex flex-col">
            {items.map((one) => (
              <li
                key={one.employeeId}
                className="flex items-center gap-3 border-b border-(--color-line) py-2 text-sm last:border-0"
              >
                <span className="min-w-0 flex-1 truncate">{one.fullName}</span>
                <span className="font-mono text-xs text-(--color-muted)">{one.code}</span>
                <span className="tabular-nums">{money(Number(one.amount), locale)}</span>
                {editable ? (
                  <Button
                    type="button"
                    tone="quiet"
                    size="sm"
                    onClick={() =>
                      setItems(items.filter((row) => row.employeeId !== one.employeeId))
                    }
                  >
                    {common("close")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm">
            {t("bonusTotal")}{" "}
            <span className="font-semibold tabular-nums">{money(total, locale)}</span>
          </p>
        </>
      ) : (
        <p className="mt-3 text-sm text-(--color-muted)">{t("bonusEmpty")}</p>
      )}

      {fault ? (
        <p role="alert" className="mt-3 text-sm text-(--color-danger)">
          {fault}
        </p>
      ) : null}
      {load.data ? (
        <p className="mt-3 text-sm text-(--color-ok)">
          {t("bonusLoaded", { count: load.data.items })}
        </p>
      ) : null}

      {editable ? (
        <Button
          type="button"
          className="mt-3"
          disabled={items.length === 0 || load.isPending}
          onClick={() => {
            setFault(null);
            load.mutate();
          }}
        >
          {load.isPending ? common("saving") : t("bonusSave")}
        </Button>
      ) : null}
    </div>
  );
}
