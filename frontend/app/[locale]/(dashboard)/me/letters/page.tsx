"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";
import { useSession } from "@/lib/auth";

const KINDS = ["EMPLOYMENT", "INCOME"] as const;
const MONTH_CHOICES = [1, 3, 6, 12];
const DEFAULT_MONTHS = 3;

interface Letter {
  id: string;
  kind: (typeof KINDS)[number];
  state: "REQUESTED" | "ISSUED" | "REJECTED";
  purpose: string;
  serial: string | null;
  createdAt: string;
  note: string | null;
  employee?: { code: string; fullName: string };
}

const DESK = ["ADMIN", "HR", "PAYROLL"];

export default function MyLettersPage() {
  const t = useTranslations("certificates");
  const common = useTranslations("common");
  const format = useFormatter();
  const cache = useQueryClient();
  const faultOf = useFault();
  const role = useSession((s) => s.role);
  const mayIssue = role !== null && DESK.includes(role);

  const [kind, setKind] = useState<(typeof KINDS)[number]>("EMPLOYMENT");
  const [purpose, setPurpose] = useState("");
  const [months, setMonths] = useState(DEFAULT_MONTHS);
  const [reading, setReading] = useState<{ serial: string; text: string } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  const letters = useQuery({
    queryKey: ["certificates"],
    queryFn: async () => (await api.get<{ rows: Letter[] }>("/certificates")).data.rows,
  });

  const ask = useMutation({
    mutationFn: async () =>
      api.post("/certificates", {
        kind,
        purpose,
        ...(kind === "INCOME" ? { months } : {}),
      }),
    onSuccess: () => {
      setPurpose("");
      setRefused(null);
      void cache.invalidateQueries({ queryKey: ["certificates"] });
    },
    onError: (fell) => setRefused(faultOf(fell)),
  });

  const decide = useMutation({
    mutationFn: async (what: { id: string; how: "issue" | "reject" }) =>
      api.post(`/certificates/${what.id}/${what.how}`, {}),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["certificates"] }),
    onError: (fell) => setRefused(faultOf(fell)),
  });

  const open = useMutation({
    mutationFn: async (id: string) =>
      (await api.get<{ serial: string; text: string }>(`/certificates/${id}/letter`)).data,
    onSuccess: (held) => setReading(held),
    onError: (fell) => setRefused(faultOf(fell)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    ask.mutate();
  }

  return (
    <section className="max-w-3xl">
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-(--color-muted)">{t("lead")}</p>

      <form
        onSubmit={submit}
        className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface) p-4"
      >
        <label className="block text-sm font-medium" htmlFor="kind">
          {t("kind")}
        </label>
        <Select
          id="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
          className="mt-1"
        >
          {KINDS.map((one) => (
            <option key={one} value={one}>
              {t(one)}
            </option>
          ))}
        </Select>

        {kind === "INCOME" ? (
          <>
            <label className="mt-4 block text-sm font-medium" htmlFor="months">
              {t("months")}
            </label>
            <Select
              id="months"
              value={String(months)}
              onChange={(e) => setMonths(Number(e.target.value))}
              className="mt-1"
            >
              {MONTH_CHOICES.map((one) => (
                <option key={one} value={one}>
                  {one}
                </option>
              ))}
            </Select>
          </>
        ) : null}

        <label className="mt-4 block text-sm font-medium" htmlFor="purpose">
          {t("purpose")}
        </label>
        <Input
          id="purpose"
          required
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder={t("purposeHint")}
          className="mt-1"
        />

        {refused ? (
          <p role="alert" className="mt-3 text-sm text-(--color-danger)">
            {refused}
          </p>
        ) : null}

        <Button type="submit" disabled={ask.isPending} className="mt-4">
          {ask.isPending ? t("asking") : t("ask")}
        </Button>
      </form>

      {letters.isPending ? <Skeleton className="mt-4 h-40 w-full" /> : null}

      {letters.isSuccess && letters.data.length === 0 ? (
        <div className="mt-4">
          <Empty title={t("empty")} />
        </div>
      ) : null}

      {letters.isSuccess && letters.data.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-2">
          {letters.data.map((one) => (
            <li
              key={one.id}
              className="rounded-xl border border-(--color-line) bg-(--color-surface) p-3"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-medium">{t(one.kind)}</span>
                <span
                  className={[
                    "rounded-full px-2 py-0.5 text-xs",
                    one.state === "ISSUED"
                      ? "bg-(--color-accent) text-white"
                      : one.state === "REJECTED"
                        ? "bg-(--color-danger) text-white"
                        : "bg-(--color-ground) text-(--color-muted)",
                  ].join(" ")}
                >
                  {t(one.state)}
                </span>
                {one.serial ? (
                  <span className="text-xs text-(--color-muted) tabular-nums">
                    {t("serial")} {one.serial}
                  </span>
                ) : null}
                <span className="ml-auto text-xs text-(--color-muted)">
                  {format.dateTime(new Date(one.createdAt), "day")}
                </span>
              </div>
              <p className="mt-1 text-sm text-(--color-muted)">{one.purpose}</p>
              {one.employee ? (
                <p className="mt-1 text-xs text-(--color-muted)">
                  {t("person")}: {one.employee.code} · {one.employee.fullName}
                </p>
              ) : null}
              {one.note ? (
                <p className="mt-1 text-sm text-(--color-danger)">{one.note}</p>
              ) : null}

              <div className="mt-3 flex flex-wrap gap-2">
                {one.state === "ISSUED" ? (
                  <Button size="sm" tone="quiet" onClick={() => open.mutate(one.id)}>
                    {t("view")}
                  </Button>
                ) : null}
                {mayIssue && one.state === "REQUESTED" ? (
                  <>
                    <Button
                      size="sm"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ id: one.id, how: "issue" })}
                    >
                      {t("issue")}
                    </Button>
                    <Button
                      size="sm"
                      tone="quiet"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ id: one.id, how: "reject" })}
                    >
                      {t("reject")}
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <Sheet
        open={reading !== null}
        onClose={() => setReading(null)}
        title={reading?.serial ?? ""}
        closeLabel={t("close")}
      >
        <pre className="max-h-[60vh] overflow-auto text-xs leading-relaxed whitespace-pre-wrap">
          {reading?.text}
        </pre>
        <Button className="mt-4 w-full" onClick={() => window.print()}>
          {t("print")}
        </Button>
      </Sheet>
    </section>
  );
}
