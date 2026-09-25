"use client";

import { Banner, Button, Combobox, Input, LayerDialog, Select } from "@cloudflare/kumo";
import { PlusIcon, TrashIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { DateField } from "@/components/ui/date-field";
import { useNotify } from "@/components/ui/notify";
import { useOptional } from "@/components/ui/optional";
import { api } from "@/lib/api";
import { useSession, type Role } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { dayOnly, money } from "@/lib/format";

const REASONS = ["HIRE", "PROMOTION", "ANNUAL_REVIEW", "ADJUSTMENT", "TRANSFER", "OTHER"] as const;
// Payroll runs pay but does not set it (KEHOACH 9.4).
const PAY_WRITERS: ReadonlySet<Role> = new Set<Role>(["ADMIN", "HR"]);
const kNoteMax = 500;
const kMaxAllowances = 20;

type Reason = (typeof REASONS)[number];

interface PayslipPage {
  rows: PayslipRow[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
}

interface Allowance {
  id: string;
  typeId: string | null;
  code: string;
  label: string;
  amount: string;
}

interface PayRecord {
  id: string;
  effectiveFrom: string;
  baseSalary: string;
  insuranceSalary: string;
  reason: Reason;
  allowances: Allowance[];
}

interface AllowanceType {
  id: string;
  code: string;
  name: string;
  taxable: boolean;
  insurable: boolean;
}

interface AllowanceRow {
  key: number;
  typeId: string;
  amount: string;
}

interface PayslipRow {
  id: string;
  grossPay: string;
  netPay: string;
  period?: { year: number; month: number };
}

function firstOfNextMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

function wholeDong(value: string): boolean {
  const amount = Number(value);
  return value !== "" && Number.isInteger(amount) && amount >= 0;
}

/** One allowance line of a pay record: the type from the catalogue and its monthly amount. */
function AllowanceLine({
  at,
  row,
  types,
  taken,
  tried,
  onChange,
  onRemove,
}: {
  at: number;
  row: AllowanceRow;
  types: AllowanceType[];
  taken: ReadonlySet<string>;
  tried: boolean;
  onChange: (patch: Partial<AllowanceRow>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("allowances");
  const common = useTranslations("common");
  const locale = useLocale();
  const choices = types.filter((one) => one.id === row.typeId || !taken.has(one.id));
  const held = types.find((one) => one.id === row.typeId) ?? null;
  return (
    <div className="grid items-start gap-2 sm:grid-cols-[1fr_11rem_auto] [&>*]:min-w-0">
      <Combobox
        items={choices}
        value={held}
        onValueChange={(next) => onChange({ typeId: (next as AllowanceType | null)?.id ?? "" })}
        itemToStringLabel={(one: AllowanceType) => one.name}
        isItemEqualToValue={(one: AllowanceType, other: AllowanceType) => one.id === other.id}
        label={t("payRowType", { n: at + 1 })}
        error={tried && row.typeId === "" ? t("payRowTypeMissing") : undefined}
      >
        <Combobox.TriggerInput placeholder={common("search")} clearLabel={common("clear")} showOptionsLabel={common("showOptions")} />
        <Combobox.Content>
          <Combobox.Empty>{common("noMatch")}</Combobox.Empty>
          <Combobox.List>
            {(one: AllowanceType) => (
              <Combobox.Item key={one.id} value={one}>
                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="truncate">{one.name}</span>
                  <span className="shrink-0 text-sm text-kumo-subtle">{one.taxable ? t("taxable") : t("taxFree")}</span>
                </span>
              </Combobox.Item>
            )}
          </Combobox.List>
        </Combobox.Content>
      </Combobox>
      <Input
        label={t("payRowAmount")}
        type="number"
        inputMode="numeric"
        min={0}
        step={1000}
        required
        value={row.amount}
        description={wholeDong(row.amount) && Number(row.amount) > 0 ? money(Number(row.amount), locale) : undefined}
        error={tried && !wholeDong(row.amount) ? t("payRowAmountInvalid") : undefined}
        onChange={(event) => onChange({ amount: event.target.value })}
        className="tabular-nums"
      />
      <Button
        variant="ghost"
        shape="square"
        icon={TrashIcon}
        aria-label={t("payRowRemove", { n: at + 1 })}
        className="sm:mt-6"
        onClick={onRemove}
      />
    </div>
  );
}

export function Pay({ employeeId }: { employeeId: number; mayWrite?: boolean }) {
  const t = useTranslations("employees");
  const allowanceText = useTranslations("allowances");
  const common = useTranslations("common");
  const locale = useLocale();
  const format = useFormatter();
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();
  const optional = useOptional();
  const { role, employeeId: mine } = useSession();
  // The server refuses the payroll desk and anybody setting their own pay, so neither gets the button.
  const writes = role !== null && PAY_WRITERS.has(role) && employeeId !== mine;

  const [open, setOpen] = useState(false);
  const [tried, setTried] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState(firstOfNextMonth);
  const [baseSalary, setBaseSalary] = useState("");
  const [insuranceSalary, setInsuranceSalary] = useState("");
  const [reason, setReason] = useState<Reason>("ANNUAL_REVIEW");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<AllowanceRow[]>([]);
  const [nextKey, setNextKey] = useState(0);

  const rows = useQuery({
    queryKey: ["compensation", employeeId],
    queryFn: async () => (await api.get<PayRecord[]>(`/employees/${employeeId}/compensation`)).data,
  });

  const types = useQuery({
    queryKey: ["allowance-types"],
    enabled: writes,
    queryFn: async () => (await api.get<AllowanceType[]>("/allowance-types")).data,
  });

  const payslips = useInfiniteQuery({
    queryKey: ["payslips", "of", employeeId],
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const after = pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : "";
      return (await api.get<PayslipPage>(`/payslips?employeeId=${employeeId}${after}`)).data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const slips = payslips.data?.pages.flatMap((one) => one.rows);
  const firstSlips = payslips.data?.pages[0];

  const add = useMutation({
    mutationFn: () =>
      api.post("/compensation", {
        employeeId,
        effectiveFrom,
        baseSalary: Number(baseSalary),
        insuranceSalary: Number(insuranceSalary),
        reason,
        note: note.trim() || undefined,
        allowances: lines.map((one) => ({ allowanceTypeId: one.typeId, amount: Number(one.amount) })),
      }),
    onSuccess: () => {
      setOpen(false);
      notify.done(t("payAdded"));
      void cache.invalidateQueries({ queryKey: ["compensation", employeeId] });
      void cache.invalidateQueries({ queryKey: ["employees", employeeId] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  // A raise adds a row with its own effective date; the allowances start as the latest record's (KEHOACH 9.6).
  function copyFrom(): void {
    const latest = rows.data?.[0];
    const carried = (latest?.allowances ?? [])
      .filter((one): one is Allowance & { typeId: string } => one.typeId !== null)
      .map((one, at) => ({ key: at, typeId: one.typeId, amount: String(Math.trunc(Number(one.amount))) }));
    setBaseSalary(latest ? String(Math.trunc(Number(latest.baseSalary))) : "");
    setInsuranceSalary(latest ? String(Math.trunc(Number(latest.insuranceSalary))) : "");
    setEffectiveFrom(firstOfNextMonth());
    setReason(latest ? "ANNUAL_REVIEW" : "HIRE");
    setNote("");
    setLines(carried);
    setNextKey(carried.length);
    setFault(null);
    setTried(false);
    setOpen(true);
  }

  function submit(): void {
    setTried(true);
    const ready =
      effectiveFrom !== "" &&
      wholeDong(baseSalary) &&
      wholeDong(insuranceSalary) &&
      lines.every((one) => one.typeId !== "" && wholeDong(one.amount));
    if (!ready) {
      return;
    }
    setFault(null);
    add.mutate();
  }

  const amount = (value: string) => money(Number(value), locale);
  const taken = new Set(lines.map((one) => one.typeId).filter((one) => one !== ""));
  const month = (at: { year: number; month: number }) =>
    format.dateTime(new Date(Date.UTC(at.year, at.month - 1, 15)), { month: "long", year: "numeric" });

  const history: Column<PayRecord>[] = [
    {
      id: "from",
      header: t("payFrom"),
      sortBy: (row) => row.effectiveFrom,
      cell: (row) => <span className="tabular-nums">{format.dateTime(dayOnly(row.effectiveFrom), "day")}</span>,
    },
    { id: "reason", header: t("payReason"), cell: (row) => t(`payReason${row.reason}`) },
    { id: "base", header: t("payBase"), numeric: true, sortBy: (row) => Number(row.baseSalary), cell: (row) => amount(row.baseSalary) },
    {
      id: "insurance",
      header: t("payInsurance"),
      numeric: true,
      priority: 2,
      sortBy: (row) => Number(row.insuranceSalary),
      cell: (row) => amount(row.insuranceSalary),
    },
    {
      id: "allowances",
      header: allowanceText("payColumn"),
      priority: 2,
      truncate: true,
      cell: (row) =>
        row.allowances.length > 0
          ? row.allowances.map((one) => `${one.label} ${amount(one.amount)}`).join(" · ")
          : common("empty"),
    },
  ];

  const slipColumns: Column<PayslipRow>[] = [
    { id: "period", header: t("payslipPeriod"), cell: (row) => (row.period ? month(row.period) : common("empty")) },
    { id: "gross", header: t("payslipGross"), numeric: true, cell: (row) => amount(row.grossPay) },
    { id: "net", header: t("payslipNet"), numeric: true, cell: (row) => amount(row.netPay) },
  ];

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0 text-lg font-semibold">{t("payHistory")}</h2>
          {writes ? (
            <Button variant="secondary" icon={PlusIcon} onClick={copyFrom}>
              {t("payAdd")}
            </Button>
          ) : null}
        </div>
        <DataTable
          id="employee-pay"
          cardLead="from"
          columns={history}
          rows={rows.data}
          keyOf={(row) => row.id}
          pending={rows.isPending}
          failed={rows.isError}
          onRetry={() => void rows.refetch()}
          empty={t("payEmpty")}
          emptyHint={writes ? t("payEmptyHint") : undefined}
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="m-0 text-lg font-semibold">{t("payslipsHere")}</h2>
        <DataTable
          id="employee-payslips"
          cardLead="period"
          columns={slipColumns}
          rows={slips}
          keyOf={(row) => row.id}
          pending={payslips.isPending}
          failed={payslips.isError}
          onRetry={() => void payslips.refetch()}
          empty={t("payslipsEmpty")}
          paging={
            firstSlips && firstSlips.total > 0
              ? {
                  shown: slips?.length ?? 0,
                  total: firstSlips.total,
                  exact: firstSlips.totalIsExact,
                  onMore: payslips.hasNextPage ? () => void payslips.fetchNextPage() : undefined,
                  loading: payslips.isFetchingNextPage,
                }
              : undefined
          }
        />
      </section>

      <LayerDialog.Root open={open} onOpenChange={setOpen} dismissDisabled={add.isPending}>
        <LayerDialog.Content size="lg" closeLabel={common("close")}>
          <LayerDialog.Title>{t("payAdd")}</LayerDialog.Title>
          <LayerDialog.Description>{t("payAddLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <form
              id="pay-add"
              className="grid items-start gap-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <DateField
                label={t("payFrom")}
                value={effectiveFrom}
                error={tried && effectiveFrom === "" ? common("required") : undefined}
                onChange={setEffectiveFrom}
              />
              <Select
                label={t("payReason")}
                value={reason}
                onValueChange={(next) => setReason(String(next ?? "OTHER") as Reason)}
                items={Object.fromEntries(REASONS.map((one) => [one, t(`payReason${one}`)]))}
                className="w-full"
              />
              <Input
                label={t("payBase")}
                description={Number(baseSalary) > 0 ? amount(baseSalary) : undefined}
                type="number"
                inputMode="numeric"
                min={0}
                required
                value={baseSalary}
                error={tried && !wholeDong(baseSalary) ? common("required") : undefined}
                onChange={(event) => setBaseSalary(event.target.value)}
                className="tabular-nums"
              />
              <Input
                label={t("payInsurance")}
                description={Number(insuranceSalary) > 0 ? amount(insuranceSalary) : t("payInsuranceHint")}
                type="number"
                inputMode="numeric"
                min={0}
                required
                value={insuranceSalary}
                error={tried && !wholeDong(insuranceSalary) ? common("required") : undefined}
                onChange={(event) => setInsuranceSalary(event.target.value)}
                className="tabular-nums"
              />
              <fieldset className="flex flex-col gap-3 sm:col-span-2">
                <legend className="mb-1 font-medium">{allowanceText("payRows")}</legend>
                <p className="text-sm text-kumo-subtle">
                  {(types.data?.length ?? 0) === 0 && types.isSuccess ? allowanceText("payNoTypes") : allowanceText("payRowsHint")}
                </p>
                {lines.map((one, at) => (
                  <AllowanceLine
                    key={one.key}
                    at={at}
                    row={one}
                    types={types.data ?? []}
                    taken={taken}
                    tried={tried}
                    onChange={(patch) => setLines(lines.map((held) => (held.key === one.key ? { ...held, ...patch } : held)))}
                    onRemove={() => setLines(lines.filter((held) => held.key !== one.key))}
                  />
                ))}
                {(types.data?.length ?? 0) > lines.length && lines.length < kMaxAllowances ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={PlusIcon}
                    className="self-start"
                    onClick={() => {
                      setLines([...lines, { key: nextKey, typeId: "", amount: "" }]);
                      setNextKey(nextKey + 1);
                    }}
                  >
                    {allowanceText("payRowAdd")}
                  </Button>
                ) : null}
              </fieldset>
              <div className="sm:col-span-2">
                <Input
                  label={optional(t("contractNote"))}
                  maxLength={kNoteMax}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </div>
            </form>
            {fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} className="mt-4" /> : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary type="submit" form="pay-add" loading={add.isPending}>
              {t("payAdd")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </div>
  );
}
