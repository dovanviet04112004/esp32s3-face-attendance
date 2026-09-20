"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { StatePill, type RequestRow } from "@/components/requests/request-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";

interface Balance {
  leaveTypeId: string;
  name: string;
  remaining: number;
  bookedAfter: number;
}

const RELATIONS = ["CHILD", "SPOUSE", "PARENT", "SIBLING", "OTHER"] as const;

interface Dependent {
  id: string;
  fullName: string;
  relation: (typeof RELATIONS)[number];
  fromMonth: string;
  state: "PENDING" | "ACTIVE" | "REJECTED" | "ENDED";
}

interface Me {
  id: number;
  code: string;
  fullName: string;
  department: { id: string; name: string } | null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function MyPage() {
  const t = useTranslations("me");
  const r = useTranslations("requests");
  const common = useTranslations("common");
  const employeeId = useSession((s) => s.employeeId);
  const [asOf, setAsOf] = useState(today);
  const [dependentName, setDependentName] = useState("");
  const [relation, setRelation] = useState<(typeof RELATIONS)[number]>("CHILD");
  const [fromMonth, setFromMonth] = useState(today);
  const [fault, setFault] = useState<string | null>(null);
  const cache = useQueryClient();
  const faultOf = useFault();

  const me = useQuery({
    queryKey: ["employees", employeeId],
    enabled: employeeId !== null,
    queryFn: async () => (await api.get<Me>(`/employees/${employeeId}`)).data,
  });

  const balances = useQuery({
    queryKey: ["leave-balances", asOf],
    enabled: employeeId !== null,
    queryFn: async () => (await api.get<Balance[]>(`/leave-balances?asOf=${asOf}`)).data,
  });

  const dependents = useQuery({
    queryKey: ["dependents", employeeId],
    enabled: employeeId !== null,
    queryFn: async () =>
      (await api.get<Dependent[]>(`/employees/${employeeId}/dependents`)).data,
  });

  const addDependent = useMutation({
    mutationFn: () =>
      api.post("/dependents", { fullName: dependentName, relation, fromMonth }),
    onSuccess: () => {
      setDependentName("");
      void cache.invalidateQueries({ queryKey: ["dependents"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const waiting = useQuery({
    queryKey: ["requests", "mine", employeeId],
    enabled: employeeId !== null,
    queryFn: async () =>
      (await api.get<{ rows: RequestRow[]; total: number }>(`/requests?employeeId=${employeeId}`))
        .data,
  });

  if (employeeId === null) {
    return <p className="text-sm text-(--color-muted)">{t("noProfile")}</p>;
  }

  const pending = waiting.data?.rows.filter((row) => row.state === "PENDING") ?? [];

  return (
    <section className="max-w-3xl">
      <h1 className="text-lg font-semibold">
        {me.data ? t("greeting", { name: me.data.fullName }) : t("title")}
      </h1>
      <p className="mt-1 text-sm text-(--color-muted)">
        {me.data ? `${me.data.code}${me.data.department ? ` · ${me.data.department.name}` : ""}` : " "}
      </p>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{t("leaveLeft")}</h2>
        <label className="flex items-center gap-2 text-sm text-(--color-muted)">
          {t("asOf")}
          <Input
            type="date"
            value={asOf}
            onChange={(event) => setAsOf(event.target.value || today())}
            className="w-44"
          />
        </label>
      </div>
      <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {balances.isPending ? (
          <p className="text-sm text-(--color-muted)">{common("loading")}</p>
        ) : (balances.data ?? []).length === 0 ? (
          <p className="text-sm text-(--color-muted)">{common("noData")}</p>
        ) : (
          (balances.data ?? []).map((balance) => (
            <article
              key={balance.leaveTypeId}
              className="rounded-xl border border-(--color-line) bg-(--color-surface) p-4"
            >
              <p className="text-xs text-(--color-muted)">{balance.name}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{balance.remaining}</p>
              <p className="text-xs text-(--color-muted)">{t("daysUnit")}</p>
              {balance.bookedAfter > 0 ? (
                <p className="mt-2 text-xs text-(--color-warn)">
                  {t("bookedAfter", { days: balance.bookedAfter })}
                </p>
              ) : null}
            </article>
          ))
        )}
      </div>

      <h2 className="mt-8 text-sm font-medium">{t("dependentsTitle")}</h2>
      <p className="mt-1 text-sm text-(--color-muted)">{t("dependentsLead")}</p>

      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          setFault(null);
          addDependent.mutate();
        }}
      >
        <Input
          aria-label={t("dependentName")}
          required
          maxLength={120}
          value={dependentName}
          onChange={(event) => setDependentName(event.target.value)}
          className="min-w-48 flex-1"
        />
        <Select
          aria-label={t("dependentRelation")}
          value={relation}
          onChange={(event) => setRelation(event.target.value as (typeof RELATIONS)[number])}
          className="w-40"
        >
          {RELATIONS.map((one) => (
            <option key={one} value={one}>
              {t(`relation${one}`)}
            </option>
          ))}
        </Select>
        <Input
          aria-label={t("dependentFrom")}
          type="date"
          required
          value={fromMonth}
          onChange={(event) => setFromMonth(event.target.value)}
          className="w-44"
        />
        <Button type="submit" disabled={addDependent.isPending}>
          {addDependent.isPending ? common("saving") : t("dependentAdd")}
        </Button>
      </form>

      {fault ? (
        <p role="alert" className="mt-3 text-sm text-(--color-danger)">
          {fault}
        </p>
      ) : null}

      <div className="mt-3 rounded-xl border border-(--color-line) bg-(--color-surface)">
        {dependents.data?.length ? (
          <ul className="divide-y divide-(--color-line)">
            {dependents.data.map((one) => (
              <li key={one.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className="min-w-0 flex-1 truncate">{one.fullName}</span>
                <span className="text-(--color-muted)">{t(`relation${one.relation}`)}</span>
                <span className="tabular-nums text-(--color-muted)">
                  {one.fromMonth.slice(0, 10)}
                </span>
                <span className="text-xs">{t(`dependentState${one.state}`)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-sm text-(--color-muted)">{t("dependentsEmpty")}</p>
        )}
      </div>

      <div className="mt-8 flex items-baseline justify-between">
        <h2 className="text-sm font-medium">{t("selfService")}</h2>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {[
          { href: "/me/letters" as const, label: t("askLetter"), hint: t("askLetterHint") },
          { href: "/me/profile" as const, label: t("askProfile"), hint: t("askProfileHint") },
        ].map((one) => (
          <Link
            key={one.href}
            href={one.href}
            className="rounded-xl border border-(--color-line) bg-(--color-surface) p-4 hover:bg-(--color-ground)"
          >
            <p className="text-sm font-medium">{one.label}</p>
            <p className="mt-1 text-sm text-(--color-muted)">{one.hint}</p>
          </Link>
        ))}
      </div>

      <div className="mt-8 flex items-baseline justify-between">
        <h2 className="text-sm font-medium">{t("pendingRequests")}</h2>
        <Link href="/me/requests" className="text-sm text-(--color-accent) hover:underline">
          {r("mine")}
        </Link>
      </div>
      <div className="mt-2 rounded-xl border border-(--color-line) bg-(--color-surface)">
        {pending.length === 0 ? (
          <p className="px-4 py-6 text-sm text-(--color-muted)">{r("mineEmpty")}</p>
        ) : (
          <ul className="divide-y divide-(--color-line)">
            {pending.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span>
                  {r(`kind${row.kind}`)} · {Number(row.days)} {t("daysUnit")}
                </span>
                <StatePill state={row.state} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
