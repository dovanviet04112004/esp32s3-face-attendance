"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";

const KINDS = ["PROBATION", "FIXED_TERM", "INDEFINITE", "SEASONAL", "INTERNSHIP"] as const;
const ENDINGS = ["ENDED", "TERMINATED"] as const;

type Kind = (typeof KINDS)[number];
type Ending = (typeof ENDINGS)[number];

export interface Contract {
  id: string;
  kind: Kind;
  state: "DRAFT" | "ACTIVE" | "ENDED" | "TERMINATED";
  number: string | null;
  startDate: string;
  endDate: string | null;
  probationEnd: string | null;
}

function day(value: string | null): string {
  return value ? value.slice(0, 10) : "";
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function Contracts({ employeeId, mayWrite }: { employeeId: number; mayWrite: boolean }) {
  const t = useTranslations("employees");
  const common = useTranslations("common");
  const cache = useQueryClient();
  const faultOf = useFault();

  const [adding, setAdding] = useState(false);
  const [ending, setEnding] = useState<Contract | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("PROBATION");
  const [number, setNumber] = useState("");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState("");
  const [probationEnd, setProbationEnd] = useState("");
  const [state, setState] = useState<Ending>("ENDED");
  const [note, setNote] = useState("");

  const rows = useQuery({
    queryKey: ["contracts", employeeId],
    queryFn: async () => (await api.get<Contract[]>(`/employees/${employeeId}/contracts`)).data,
  });

  function done(): void {
    setAdding(false);
    setEnding(null);
    setNote("");
    void cache.invalidateQueries({ queryKey: ["contracts", employeeId] });
    void cache.invalidateQueries({ queryKey: ["employees", employeeId] });
  }

  const add = useMutation({
    mutationFn: () =>
      api.post("/contracts", {
        employeeId,
        kind,
        startDate,
        number: number || undefined,
        endDate: endDate || undefined,
        probationEnd: probationEnd || undefined,
      }),
    onSuccess: done,
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const close = useMutation({
    mutationFn: (one: Contract) =>
      api.patch(`/contracts/${one.id}`, { state, note: note || undefined }),
    onSuccess: done,
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    setFault(null);
    add.mutate();
  }

  return (
    <div className="mt-4">
      {mayWrite ? (
        <Button type="button" className="mb-3" onClick={() => setAdding(true)}>
          {t("contractAdd")}
        </Button>
      ) : null}

      {rows.data?.length ? (
        <ul className="flex flex-col gap-2">
          {rows.data.map((one) => (
            <li
              key={one.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-(--color-line) bg-(--color-surface) p-3 text-sm"
            >
              <span className="font-medium">{t(`contract${one.kind}`)}</span>
              <span className="text-(--color-muted)">{t(`contract${one.state}`)}</span>
              {one.number ? <span className="font-mono text-xs">{one.number}</span> : null}
              <span className="tabular-nums">
                {day(one.startDate)} → {one.endDate ? day(one.endDate) : t("contractOpen")}
              </span>
              {one.probationEnd ? (
                <span className="text-xs text-(--color-muted)">
                  {t("probationEnds")} {day(one.probationEnd)}
                </span>
              ) : null}
              {mayWrite && (one.state === "ACTIVE" || one.state === "DRAFT") ? (
                <Button
                  type="button"
                  tone="quiet"
                  size="sm"
                  className="ms-auto"
                  onClick={() => {
                    setFault(null);
                    setEnding(one);
                  }}
                >
                  {t("contractEnd")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-(--color-muted)">
          {rows.isPending ? common("loading") : t("contractsEmpty")}
        </p>
      )}

      <Sheet
        open={adding}
        onClose={() => setAdding(false)}
        title={t("contractAdd")}
        closeLabel={common("close")}
      >
        <form onSubmit={submit}>
          <label className="block text-sm font-medium" htmlFor="contractKind">
            {t("contractKind")}
          </label>
          <Select
            id="contractKind"
            value={kind}
            onChange={(event) => setKind(event.target.value as Kind)}
            className="mt-1"
          >
            {KINDS.map((one) => (
              <option key={one} value={one}>
                {t(`contract${one}`)}
              </option>
            ))}
          </Select>

          <label className="mt-4 block text-sm font-medium" htmlFor="contractNumber">
            {t("contractNumber")}
          </label>
          <Input
            id="contractNumber"
            maxLength={64}
            value={number}
            onChange={(event) => setNumber(event.target.value)}
            className="mt-1"
          />

          <label className="mt-4 block text-sm font-medium" htmlFor="contractStart">
            {t("contractStart")}
          </label>
          <Input
            id="contractStart"
            type="date"
            required
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
            className="mt-1"
          />

          <label className="mt-4 block text-sm font-medium" htmlFor="contractEnd">
            {t("contractEndDate")}
          </label>
          <Input
            id="contractEnd"
            type="date"
            min={startDate}
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
            className="mt-1"
          />
          <p className="mt-1 text-xs text-(--color-muted)">{t("contractEndHint")}</p>

          <label className="mt-4 block text-sm font-medium" htmlFor="contractProbation">
            {t("probationEnds")}
          </label>
          <Input
            id="contractProbation"
            type="date"
            min={startDate}
            value={probationEnd}
            onChange={(event) => setProbationEnd(event.target.value)}
            className="mt-1"
          />

          {fault ? (
            <p role="alert" className="mt-3 text-sm text-(--color-danger)">
              {fault}
            </p>
          ) : null}
          <Button type="submit" disabled={add.isPending} className="mt-4">
            {add.isPending ? common("saving") : common("save")}
          </Button>
        </form>
      </Sheet>

      <Sheet
        open={ending !== null}
        onClose={() => setEnding(null)}
        title={t("contractEnd")}
        closeLabel={common("close")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setFault(null);
            if (ending) {
              close.mutate(ending);
            }
          }}
        >
          <label className="block text-sm font-medium" htmlFor="contractState">
            {t("contractHow")}
          </label>
          <Select
            id="contractState"
            value={state}
            onChange={(event) => setState(event.target.value as Ending)}
            className="mt-1"
          >
            {ENDINGS.map((one) => (
              <option key={one} value={one}>
                {t(`contract${one}`)}
              </option>
            ))}
          </Select>

          <label className="mt-4 block text-sm font-medium" htmlFor="contractNote">
            {t("contractNote")}
          </label>
          <Input
            id="contractNote"
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="mt-1"
          />

          {fault ? (
            <p role="alert" className="mt-3 text-sm text-(--color-danger)">
              {fault}
            </p>
          ) : null}
          <Button type="submit" disabled={close.isPending} className="mt-4">
            {close.isPending ? common("saving") : common("save")}
          </Button>
        </form>
      </Sheet>
    </div>
  );
}
