"use client";

import { Banner, Button, Input, LayerDialog, Select } from "@cloudflare/kumo";
import { PlusIcon, WarningCircleIcon, XCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { DateField } from "@/components/ui/date-field";
import { useNotify } from "@/components/ui/notify";
import { useOptional } from "@/components/ui/optional";
import { StatePill, type Tone } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";
import { dayOnly } from "@/lib/format";

const KINDS = ["PROBATION", "FIXED_TERM", "INDEFINITE", "SEASONAL", "INTERNSHIP"] as const;
const ENDINGS = ["ENDED", "TERMINATED"] as const;
const TONE: Record<Contract["state"], Tone> = { DRAFT: "waiting", ACTIVE: "good", ENDED: "idle", TERMINATED: "bad" };

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

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function Contracts({ employeeId, mayWrite }: { employeeId: number; mayWrite: boolean }) {
  const t = useTranslations("employees");
  const common = useTranslations("common");
  const format = useFormatter();
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();
  const optional = useOptional();

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

  const day = (value: string) => format.dateTime(dayOnly(value), "day");

  function refresh(): void {
    void cache.invalidateQueries({ queryKey: ["contracts", employeeId] });
    void cache.invalidateQueries({ queryKey: ["employees", employeeId] });
    void cache.invalidateQueries({ queryKey: ["reports", "attention"] });
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
    onSuccess: () => {
      setAdding(false);
      notify.done(t("contractAdded"));
      refresh();
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const close = useMutation({
    mutationFn: (one: Contract) => api.patch(`/contracts/${one.id}`, { state, note: note || undefined }),
    onSuccess: () => {
      setEnding(null);
      notify.done(t("contractClosed"));
      refresh();
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function openAdd(): void {
    setFault(null);
    setKind("PROBATION");
    setNumber("");
    setStartDate(today());
    setEndDate("");
    setProbationEnd("");
    setAdding(true);
  }

  function openEnd(one: Contract): void {
    setFault(null);
    setState("ENDED");
    setNote("");
    setEnding(one);
  }

  const columns: Column<Contract>[] = [
    { id: "kind", header: t("contractKind"), sortBy: (row) => row.kind, cell: (row) => t(`contract${row.kind}`) },
    {
      id: "span",
      header: t("contractSpan"),
      sortBy: (row) => row.startDate,
      cell: (row) => (
        <span className="whitespace-nowrap tabular-nums">
          {day(row.startDate)} → {row.endDate ? day(row.endDate) : t("contractOpen")}
        </span>
      ),
    },
    {
      id: "state",
      header: t("status"),
      sortBy: (row) => row.state,
      cell: (row) => <StatePill tone={TONE[row.state]}>{t(`contract${row.state}`)}</StatePill>,
    },
    {
      id: "number",
      header: t("contractNumber"),
      cell: (row) => (row.number ? <span className="font-mono whitespace-nowrap">{row.number}</span> : common("empty")),
    },
    {
      id: "probation",
      header: t("probationEnds"),
      cell: (row) => (row.probationEnd ? <span className="whitespace-nowrap tabular-nums">{day(row.probationEnd)}</span> : common("empty")),
    },
  ];

  const faultBanner = fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} className="mt-4" /> : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-lg font-semibold">{t("contractsTitle")}</h2>
        {mayWrite ? (
          <Button variant="secondary" icon={PlusIcon} onClick={openAdd}>
            {t("contractAdd")}
          </Button>
        ) : null}
      </div>

      <DataTable
        id="employee-contracts"
        cardLead="kind"
        columns={columns}
        rows={rows.data}
        keyOf={(row) => row.id}
        pending={rows.isPending}
        failed={rows.isError}
        onRetry={() => void rows.refetch()}
        empty={t("contractsEmpty")}
        emptyHint={mayWrite ? t("contractsEmptyHint") : undefined}
        emptyAction={
          mayWrite ? (
            <Button variant="secondary" icon={PlusIcon} onClick={openAdd}>
              {t("contractAdd")}
            </Button>
          ) : undefined
        }
        rowActions={
          mayWrite
            ? (row) =>
                row.state === "ACTIVE" || row.state === "DRAFT"
                  ? [{ key: "end", label: t("contractEndAction"), icon: XCircleIcon, danger: true, onSelect: () => openEnd(row) }]
                  : []
            : undefined
        }
      />

      <LayerDialog.Root open={adding} onOpenChange={setAdding} dismissDisabled={add.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("contractAdd")}</LayerDialog.Title>
          <LayerDialog.Body>
            <form
              id="contract-add"
              className="grid items-start gap-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                setFault(null);
                add.mutate();
              }}
            >
              <Select
                label={t("contractKind")}
                value={kind}
                onValueChange={(next) => setKind(String(next ?? "PROBATION") as Kind)}
                items={Object.fromEntries(KINDS.map((one) => [one, t(`contract${one}`)]))}
                className="w-full"
              />
              <Input
                label={optional(t("contractNumber"))}
                maxLength={64}
                value={number}
                onChange={(event) => setNumber(event.target.value)}
              />
              <DateField label={t("contractStart")} required value={startDate} onChange={setStartDate} />
              <DateField
                label={t("contractEndDate")}
                description={t("contractEndHint")}
                required={false}
                min={startDate}
                value={endDate}
                onChange={setEndDate}
              />
              <DateField
                label={t("probationEnds")}
                required={false}
                min={startDate}
                value={probationEnd}
                onChange={setProbationEnd}
              />
            </form>
            {faultBanner}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary type="submit" form="contract-add" loading={add.isPending}>
              {t("contractAdd")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Alert
        open={ending !== null}
        onOpenChange={(next) => {
          if (!next) {
            setEnding(null);
          }
        }}
        dismissDisabled={close.isPending}
      >
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("contractEndAction")}</LayerDialog.Title>
          <LayerDialog.Description>
            {ending
              ? t("contractEndLead", {
                  kind: t(`contract${ending.kind}`),
                  number: ending.number ?? common("empty"),
                  from: day(ending.startDate),
                })
              : null}
          </LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              <Select
                label={t("contractHow")}
                value={state}
                onValueChange={(next) => setState(String(next ?? "ENDED") as Ending)}
                items={Object.fromEntries(ENDINGS.map((one) => [one, t(`contract${one}`)]))}
                className="w-full"
              />
              <Input
                label={optional(t("contractNote"))}
                maxLength={500}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
            {faultBanner}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              variant="destructive"
              loading={close.isPending}
              onClick={() => {
                if (ending) {
                  setFault(null);
                  close.mutate(ending);
                }
              }}
            >
              {t("contractEndAction")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </div>
  );
}
