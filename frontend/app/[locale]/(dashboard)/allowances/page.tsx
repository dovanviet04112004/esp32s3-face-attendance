"use client";

import { Banner, Button, Checkbox, Input, LayerDialog, Select } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, PencilSimpleIcon, PlusIcon, ProhibitIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { Suspense, useEffect, useState } from "react";

import { DataTable, PersonCell, type Column, type RowAction } from "@/components/tables/data-table";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { useNotify } from "@/components/ui/notify";
import { useOptional } from "@/components/ui/optional";
import { PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { money } from "@/lib/format";
import { useUrlState } from "@/lib/url-state";

// The allowance columns of D02-LT; anything else keeps an allowance off the filing.
const D02_COLUMNS = ["13", "14", "15", "16", "17"] as const;
const kCodeMax = 32;
const kNameMax = 120;

interface AllowanceType {
  id: string;
  code: string;
  name: string;
  taxable: boolean;
  insurable: boolean;
  taxFreeCap: string | null;
  d02Column: number | null;
  active: boolean;
}

interface Draft {
  held: AllowanceType | null;
  code: string;
  name: string;
  taxable: boolean;
  insurable: boolean;
  taxFreeCap: string;
  d02Column: string;
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

function Allowances() {
  const t = useTranslations("allowances");
  const shared = useTranslations("catalogues");
  const common = useTranslations("common");
  const locale = useLocale();
  const role = useSession((s) => s.role);
  const mayWrite = role === "ADMIN" || role === "PAYROLL";
  const cache = useQueryClient();
  const notify = useNotify();
  const faultOf = useFault();
  const optional = useOptional();

  const [url, setUrl] = useUrlState({ q: "", retired: "" });
  const [typed, setTyped] = useState(url.q);
  const settled = useSettled(typed.trim());
  useEffect(() => {
    if (settled !== url.q) {
      setUrl({ q: settled });
    }
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps

  const [draft, setDraft] = useState<Draft | null>(null);
  const [tried, setTried] = useState(false);
  const [retiring, setRetiring] = useState<AllowanceType | null>(null);
  const [fault, setFault] = useState<string | null>(null);

  const types = useQuery({
    queryKey: ["allowance-types", "all"],
    queryFn: async () => (await api.get<AllowanceType[]>("/allowance-types?all=true")).data,
  });

  function refresh(): void {
    void cache.invalidateQueries({ queryKey: ["allowance-types"] });
  }

  const save = useMutation({
    mutationFn: async (held: Draft) => {
      const body = {
        name: held.name.trim(),
        taxable: held.taxable,
        insurable: held.insurable,
        taxFreeCap: held.taxFreeCap === "" ? null : Number(held.taxFreeCap),
        d02Column: held.d02Column === "" ? null : Number(held.d02Column),
      };
      if (held.held) {
        return (await api.patch<AllowanceType>(`/allowance-types/${held.held.id}`, body)).data;
      }
      return (await api.post<AllowanceType>("/allowance-types", { ...body, code: held.code.trim() })).data;
    },
    onSuccess: (saved, held) => {
      notify.done(t(held.held ? "saved" : "added", { name: saved.name }));
      setDraft(null);
      refresh();
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const flip = useMutation({
    mutationFn: async (one: AllowanceType) =>
      (await api.patch<AllowanceType>(`/allowance-types/${one.id}`, { active: !one.active })).data,
    onSuccess: (saved) => {
      notify.done(t(saved.active ? "restoredDone" : "retiredDone", { name: saved.name }));
      setRetiring(null);
      refresh();
    },
    onError: (fell: unknown, one) => (one.active ? setFault(faultOf(fell)) : notify.failed(fell)),
  });

  function open(one: AllowanceType | null): void {
    setFault(null);
    setTried(false);
    setDraft({
      held: one,
      code: one?.code ?? "",
      name: one?.name ?? "",
      taxable: one?.taxable ?? true,
      insurable: one?.insurable ?? false,
      taxFreeCap: one?.taxFreeCap === null || one?.taxFreeCap === undefined ? "" : String(Number(one.taxFreeCap)),
      d02Column: one?.d02Column === null || one?.d02Column === undefined ? "" : String(one.d02Column),
    });
  }

  function submit(held: Draft): void {
    setTried(true);
    if (held.name.trim() === "" || (held.held === null && held.code.trim() === "")) {
      return;
    }
    setFault(null);
    save.mutate(held);
  }

  const needle = fold(url.q);
  const shown = types.data?.filter(
    (one) =>
      (url.retired === "1" || one.active) && (needle === "" || fold(`${one.code} ${one.name}`).includes(needle)),
  );

  const columns: Column<AllowanceType>[] = [
    { id: "type", header: shared("name"), cell: (row) => <PersonCell name={row.name} code={row.code} /> },
    {
      id: "tax",
      header: t("tax"),
      priority: 2,
      cell: (row) => (
        <StatePill tone={row.taxable ? "waiting" : "good"}>{row.taxable ? t("taxable") : t("taxFree")}</StatePill>
      ),
    },
    {
      id: "cap",
      header: t("taxFreeCapShort"),
      numeric: true,
      priority: 3,
      cell: (row) => (row.taxFreeCap === null ? common("empty") : money(Number(row.taxFreeCap), locale)),
    },
    {
      id: "insurance",
      header: t("insurance"),
      priority: 2,
      cell: (row) => (row.insurable ? t("insurable") : t("notInsurable")),
    },
    {
      id: "d02",
      header: t("d02ColumnShort"),
      numeric: true,
      priority: 3,
      cell: (row) => (row.d02Column === null ? common("empty") : row.d02Column),
    },
    {
      id: "status",
      header: shared("status"),
      cell: (row) => (
        <StatePill tone={row.active ? "good" : "idle"}>{row.active ? shared("active") : shared("retired")}</StatePill>
      ),
    },
  ];

  function actionsOf(row: AllowanceType): RowAction[] {
    const edit: RowAction = { key: "edit", label: shared("edit"), icon: PencilSimpleIcon, onSelect: () => open(row) };
    return row.active
      ? [
          edit,
          {
            key: "retire",
            label: shared("retire"),
            icon: ProhibitIcon,
            danger: true,
            onSelect: () => {
              setFault(null);
              setRetiring(row);
            },
          },
        ]
      : [edit, { key: "restore", label: shared("restore"), icon: ArrowCounterClockwiseIcon, onSelect: () => flip.mutate(row) }];
  }

  const faultBanner = fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null;
  const nameMissing = tried && draft !== null && draft.name.trim() === "";
  const codeMissing = tried && draft !== null && draft.held === null && draft.code.trim() === "";
  const capEcho = draft && draft.taxFreeCap !== "" ? money(Number(draft.taxFreeCap), locale) : undefined;

  return (
    <>
      <PageHeader
        title={t("title")}
        description={mayWrite ? t("lead") : t("leadRead")}
        actions={
          mayWrite ? (
            <Button variant="primary" icon={PlusIcon} onClick={() => open(null)}>
              {t("add")}
            </Button>
          ) : undefined
        }
      />

      <PageLayout>
        <FilterBar
          search={{ value: typed, onChange: setTyped, placeholder: shared("searchHint") }}
          extra={
            <Checkbox
              label={shared("showRetired")}
              checked={url.retired === "1"}
              onCheckedChange={(next) => setUrl({ retired: next === true ? "1" : "" })}
            />
          }
        />
        <DataTable
          id="allowance-types"
          columns={columns}
          cardLead="type"
          cardTrailing="status"
          rows={shown}
          keyOf={(row) => row.id}
          pending={types.isPending}
          failed={types.isError}
          onRetry={() => void types.refetch()}
          onRowClick={mayWrite ? open : undefined}
          rowActions={mayWrite ? actionsOf : undefined}
          empty={url.q !== "" ? shared("noMatch") : t("empty")}
          emptyHint={url.q !== "" ? undefined : t("emptyHint")}
          emptyAction={
            mayWrite && url.q === "" ? (
              <Button variant="secondary" icon={PlusIcon} onClick={() => open(null)}>
                {t("add")}
              </Button>
            ) : undefined
          }
          paging={shown ? { shown: shown.length, total: shown.length } : undefined}
        />
      </PageLayout>

      <LayerDialog.Root open={draft !== null} onOpenChange={(next) => !next && setDraft(null)} dismissDisabled={save.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{draft?.held ? t("editTitle", { code: draft.held.code }) : t("add")}</LayerDialog.Title>
          <LayerDialog.Description>{draft?.held ? t("editLead") : t("addLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            {draft ? (
              <div className="flex flex-col gap-4">
                {draft.held === null ? (
                  <Input
                    label={shared("code")}
                    required
                    maxLength={kCodeMax}
                    className="font-mono"
                    value={draft.code}
                    description={shared("codeHint")}
                    error={codeMissing ? common("required") : undefined}
                    onChange={(event) => setDraft({ ...draft, code: event.target.value.toUpperCase().replace(/\s/g, "") })}
                  />
                ) : null}
                <Input
                  label={shared("name")}
                  required
                  maxLength={kNameMax}
                  value={draft.name}
                  error={nameMissing ? common("required") : undefined}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
                <Checkbox
                  label={t("taxableLabel")}
                  checked={draft.taxable}
                  onCheckedChange={(next) => setDraft({ ...draft, taxable: next === true })}
                />
                <Input
                  label={optional(t("taxFreeCap"))}
                  type="number"
                  min={0}
                  step={1000}
                  value={draft.taxFreeCap}
                  description={capEcho ? t("capEcho", { amount: capEcho }) : t("taxFreeCapHint")}
                  onChange={(event) => setDraft({ ...draft, taxFreeCap: event.target.value })}
                />
                <Checkbox
                  label={t("insurableLabel")}
                  checked={draft.insurable}
                  onCheckedChange={(next) => setDraft({ ...draft, insurable: next === true })}
                />
                <Select
                  label={optional(t("d02Column"))}
                  hideLabel={false}
                  className="w-full"
                  value={draft.d02Column}
                  onValueChange={(next) => setDraft({ ...draft, d02Column: String(next ?? "") })}
                  items={{
                    "": t("offFiling"),
                    ...Object.fromEntries(D02_COLUMNS.map((one) => [one, t("column", { column: one })])),
                  }}
                  description={t("d02ColumnHint")}
                />
                {draft.held ? <p className="text-kumo-subtle">{t("editWarn")}</p> : null}
                {faultBanner}
              </div>
            ) : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary loading={save.isPending} onClick={() => draft && submit(draft)}>
              {draft?.held ? common("save") : t("add")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Alert open={retiring !== null} onOpenChange={(next) => !next && setRetiring(null)} dismissDisabled={flip.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{retiring ? t("retireTitle", { name: retiring.name }) : shared("retire")}</LayerDialog.Title>
          <LayerDialog.Description>{t("retireLead")}</LayerDialog.Description>
          <LayerDialog.Body>{faultBanner}</LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary variant="destructive" loading={flip.isPending} onClick={() => retiring && flip.mutate(retiring)}>
              {shared("retire")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </>
  );
}

export default function AllowancesPage() {
  return (
    <Suspense>
      <Allowances />
    </Suspense>
  );
}
