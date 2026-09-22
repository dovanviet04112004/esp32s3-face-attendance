"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Failed } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { dayOnly } from "@/lib/format";

interface Holiday {
  id: string;
  date: string;
  name: string;
  paid: boolean;
}

const kYearsBack = 1;
const kYearsOn = 1;

function thisYear(): number {
  return new Date().getUTCFullYear();
}

function yearsOnOffer(): number[] {
  const now = thisYear();
  const span: number[] = [];
  for (let at = now - kYearsBack; at <= now + kYearsOn; at += 1) {
    span.push(at);
  }
  return span;
}

export default function HolidaysPage() {
  const t = useTranslations("holidays");
  const format = useFormatter();
  const common = useTranslations("common");
  const role = useSession((s) => s.role);
  const mayWrite = role === "ADMIN" || role === "HR";
  const cache = useQueryClient();
  const faultOf = useFault();

  const [year, setYear] = useState(thisYear);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [paid, setPaid] = useState(true);
  const [fault, setFault] = useState<string | null>(null);
  // Taking a public holiday away rebuilds that day for everybody, so the
  // second click is the confirmation.
  const [dropping, setDropping] = useState<string | null>(null);

  const holidays = useQuery({
    queryKey: ["holidays", year],
    queryFn: async () => (await api.get<Holiday[]>(`/holidays?year=${year}`)).data,
  });

  const add = useMutation({
    mutationFn: () => api.post("/holidays", { date, name, paid }),
    onSuccess: () => {
      setName("");
      setDate("");
      void cache.invalidateQueries({ queryKey: ["holidays"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const drop = useMutation({
    mutationFn: (id: string) => api.delete(`/holidays/${id}`),
    onSuccess: () => {
      setDropping(null);
      void cache.invalidateQueries({ queryKey: ["holidays"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  if (holidays.isError) {
    return <Failed onRetry={() => void holidays.refetch()} />;
  }

  const rows = holidays.data ?? [];
  const paidDays = rows.filter((one) => one.paid).length;

  return (
    <section className="mx-auto w-full max-w-(--width-read)">
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-(--color-muted)">{t("lead")}</p>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <label className="block w-32 text-xs text-(--color-muted)">
          {t("year")}
          <Select value={String(year)} onChange={(event) => setYear(Number(event.target.value))} className="mt-1">
            {yearsOnOffer().map((one) => (
              <option key={one} value={one}>
                {one}
              </option>
            ))}
          </Select>
        </label>
        <p className="text-sm text-(--color-muted)">
          {t("tally", { days: rows.length, paid: paidDays })}
        </p>
      </div>

      {mayWrite ? (
        <form
          className="mt-4 flex flex-wrap items-end gap-2 rounded-xl border border-(--color-line) bg-(--color-surface) p-4"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            setFault(null);
            add.mutate();
          }}
        >
          <label className="block w-44 text-xs text-(--color-muted)">
            {t("date")}
            <Input
              type="date"
              required
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className="mt-1"
            />
          </label>
          <label className="block min-w-48 flex-1 text-xs text-(--color-muted)">
            {t("name")}
            <Input
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1"
            />
          </label>
          <Checkbox checked={paid} onChange={(event) => setPaid(event.target.checked)} label={t("paid")} />
          <Button type="submit" disabled={add.isPending}>
            {add.isPending ? common("saving") : t("add")}
          </Button>
        </form>
      ) : null}

      {fault ? (
        <p role="alert" className="mt-3 text-sm text-(--color-danger)">
          {fault}
        </p>
      ) : null}

      <div className="mt-4 flex flex-col gap-2">
        {holidays.isPending ? (
          <p className="px-4 py-6 text-sm text-(--color-muted)">{common("loading")}</p>
        ) : rows.length ? (
          rows.map((row) => (
            <article
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-(--color-line) bg-(--color-surface) p-3 text-sm"
            >
              <span className="w-32 tabular-nums">{format.dateTime(dayOnly(row.date), "day")}</span>
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              <span className="text-xs text-(--color-muted)">{row.paid ? t("paid") : t("unpaid")}</span>
              {mayWrite ? (
                <Button
                  type="button"
                  tone={dropping === row.id ? "danger" : "quiet"}
                  size="sm"
                  disabled={drop.isPending}
                  onClick={() => (dropping === row.id ? drop.mutate(row.id) : setDropping(row.id))}
                  onBlur={() => setDropping(null)}
                >
                  {dropping === row.id ? common("sure") : t("remove")}
                </Button>
              ) : null}
            </article>
          ))
        ) : (
          <p className="text-sm text-(--color-muted)">{t("empty")}</p>
        )}
      </div>
    </section>
  );
}
