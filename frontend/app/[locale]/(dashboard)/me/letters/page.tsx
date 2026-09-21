"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { BottomBar } from "@/components/ui/bottom-bar";
import { Empty, Failed } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { StatePill, type Tone } from "@/components/ui/pill";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";

const KINDS = ["EMPLOYMENT", "INCOME"] as const;
const MONTH_CHOICES = [1, 3, 6, 12];
const DEFAULT_MONTHS = 3;

const LETTER_TONE: Record<Letter["state"], Tone> = {
  REQUESTED: "waiting",
  ISSUED: "good",
  REJECTED: "bad",
};

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

export default function MyLettersPage() {
  const t = useTranslations("certificates");
  const common = useTranslations("common");
  const format = useFormatter();
  const cache = useQueryClient();
  const faultOf = useFault();
  const employeeId = useSession((one) => one.employeeId);

  const [kind, setKind] = useState<(typeof KINDS)[number]>("EMPLOYMENT");
  const [purpose, setPurpose] = useState("");
  const [months, setMonths] = useState(DEFAULT_MONTHS);
  const [reading, setReading] = useState<{ serial: string; text: string } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  const letters = useQuery({
    queryKey: ["certificates", "mine", employeeId],
    enabled: employeeId !== null,
    queryFn: async () =>
      (await api.get<{ rows: Letter[] }>(`/certificates?employeeId=${employeeId}`)).data.rows,
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

  if (letters.isError) {
    return <Failed onRetry={() => void letters.refetch()} />;
  }

  return (
    <section className="mx-auto w-full max-w-(--width-read)">
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

        <BottomBar>
          <Button type="submit" disabled={ask.isPending}>
            {ask.isPending ? t("asking") : t("ask")}
          </Button>
        </BottomBar>
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
                <StatePill tone={LETTER_TONE[one.state]}>{t(one.state)}</StatePill>
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
        <pre
          data-print
          className="max-h-[60vh] overflow-auto text-sm leading-relaxed whitespace-pre-wrap"
        >
          {reading?.text}
        </pre>
        <Button className="mt-4 w-full" onClick={() => window.print()}>
          {t("print")}
        </Button>
      </Sheet>
    </section>
  );
}
