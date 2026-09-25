"use client";

import { Banner, Button, Checkbox, Input, LayerDialog } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, PlusIcon, ProhibitIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Suspense, useState } from "react";

import { DataTable, PersonCell, type Column, type RowAction } from "@/components/tables/data-table";
import { FilterBar } from "@/components/ui/filter-bar";
import { useNotify } from "@/components/ui/notify";
import { useOptional } from "@/components/ui/optional";
import { PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { useUrlState } from "@/lib/url-state";

interface LeaveType {
  id: string;
  code: string;
  name: string;
  paid: boolean;
  daysPerYear: string;
  carryOverMax: string;
  calendarDays: boolean;
  active: boolean;
}

interface Draft {
  code: string;
  name: string;
  paid: boolean;
  daysPerYear: string;
  carryOverMax: string;
  calendarDays: boolean;
}

const kBlank: Draft = { code: "", name: "", paid: true, daysPerYear: "", carryOverMax: "0", calendarDays: false };
const kCodeMax = 32;
const kNameMax = 120;

export default function LeaveTypesPage() {
  return (
    <Suspense>
      <LeaveTypes />
    </Suspense>
  );
}

function LeaveTypes() {
  const t = useTranslations("leaveTypes");
  const shared = useTranslations("catalogues");
  const common = useTranslations("common");
  const optional = useOptional();
  const role = useSession((s) => s.role);
  const mayWrite = role === "ADMIN" || role === "HR";
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();

  const [url, setUrl] = useUrlState({ retired: "" });
  const [tried, setTried] = useState(false);
  const [editing, setEditing] = useState<LeaveType | null>(null);
  const [adding, setAdding] = useState(false);
  const [retiring, setRetiring] = useState<LeaveType | null>(null);
  const [draft, setDraft] = useState<Draft>(kBlank);
  const [fault, setFault] = useState<string | null>(null);

  const types = useQuery({
    queryKey: ["leave-types", "all"],
    queryFn: async () => (await api.get<LeaveType[]>("/leave-types/all")).data,
  });

  function refresh(): void {
    void cache.invalidateQueries({ queryKey: ["leave-types"] });
  }

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: draft.name.trim(),
        paid: draft.paid,
        daysPerYear: Number(draft.daysPerYear),
        carryOverMax: Number(draft.carryOverMax || "0"),
        calendarDays: draft.calendarDays,
      };
      if (editing) {
        await api.patch(`/leave-types/${editing.id}`, body);
      } else {
        await api.post("/leave-types", { ...body, code: draft.code.trim().toUpperCase() });
      }
    },
    onSuccess: () => {
      notify.done(editing ? t("saved", { name: draft.name.trim() }) : t("added", { name: draft.name.trim() }));
      setAdding(false);
      setEditing(null);
      refresh();
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const flip = useMutation({
    mutationFn: (one: LeaveType) => api.patch(`/leave-types/${one.id}`, { active: !one.active }),
    onSuccess: (_, one) => {
      notify.done(one.active ? t("retiredDone", { name: one.name }) : t("restoredDone", { name: one.name }));
      setRetiring(null);
      refresh();
    },
    onError: notify.failed,
  });

  function openForm(one: LeaveType | null): void {
    setFault(null);
    setTried(false);
    setDraft(
      one
        ? {
            code: one.code,
            name: one.name,
            paid: one.paid,
            daysPerYear: String(Number(one.daysPerYear)),
            carryOverMax: String(Number(one.carryOverMax)),
            calendarDays: one.calendarDays,
          }
        : kBlank,
    );
    setEditing(one);
    setAdding(one === null);
  }

  function submit(): void {
    setTried(true);
    if (draft.name.trim() === "" || draft.daysPerYear === "" || (editing === null && draft.code.trim() === "")) {
      return;
    }
    setFault(null);
    save.mutate();
  }

  const shown = types.data?.filter((one) => url.retired === "1" || one.active);

  const columns: Column<LeaveType>[] = [
    { id: "name", header: t("name"), sortBy: (row) => row.name, cell: (row) => <PersonCell name={row.name} code={row.code} /> },
    {
      id: "paid",
      header: t("pay"),
      priority: 2,
      sortBy: (row) => (row.paid ? 1 : 0),
      cell: (row) => <StatePill tone={row.paid ? "good" : "idle"}>{row.paid ? t("paid") : t("unpaid")}</StatePill>,
    },
    {
      id: "daysPerYear",
      header: t("daysPerYearShort"),
      numeric: true,
      sortBy: (row) => Number(row.daysPerYear),
      cell: (row) => Number(row.daysPerYear),
    },
    {
      id: "countedBy",
      header: t("countedBy"),
      priority: 3,
      cell: (row) => (row.calendarDays ? t("countCalendar") : t("countWorking")),
    },
    {
      id: "carryOverMax",
      header: t("carryOverShort"),
      numeric: true,
      priority: 3,
      sortBy: (row) => Number(row.carryOverMax),
      cell: (row) => Number(row.carryOverMax),
    },
    {
      id: "status",
      header: shared("status"),
      cell: (row) => <StatePill tone={row.active ? "good" : "idle"}>{row.active ? shared("active") : shared("retired")}</StatePill>,
    },
  ];

  function actionsOf(row: LeaveType): RowAction[] {
    return row.active
      ? [{ key: "retire", label: t("retire"), icon: ProhibitIcon, danger: true, onSelect: () => setRetiring(row) }]
      : [{ key: "restore", label: t("restore"), icon: ArrowCounterClockwiseIcon, onSelect: () => flip.mutate(row) }];
  }

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("lead")}
        actions={
          mayWrite ? (
            <Button variant="primary" icon={PlusIcon} onClick={() => openForm(null)}>
              {t("add")}
            </Button>
          ) : undefined
        }
      />

      <PageLayout>
        <FilterBar
          extra={
            <Checkbox
              label={shared("showRetired")}
              checked={url.retired === "1"}
              onCheckedChange={(next) => setUrl({ retired: next === true ? "1" : "" })}
            />
          }
        />
        <DataTable
          id="leave-types"
          cardLead="name"
          cardTrailing="status"
          columns={columns}
          rows={shown}
          keyOf={(row) => row.id}
          pending={types.isPending}
          failed={types.isError}
          onRetry={() => void types.refetch()}
          onRowClick={mayWrite ? openForm : undefined}
          rowActions={mayWrite ? actionsOf : undefined}
          empty={t("empty")}
          emptyAction={
            mayWrite ? (
              <Button variant="secondary" icon={PlusIcon} onClick={() => openForm(null)}>
                {t("add")}
              </Button>
            ) : undefined
          }
        />
      </PageLayout>

      <LayerDialog.Root
        open={adding || editing !== null}
        onOpenChange={(next) => {
          if (!next) {
            setAdding(false);
            setEditing(null);
          }
        }}
        dismissDisabled={save.isPending}
      >
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{editing ? t("editTitle", { code: editing.code }) : t("add")}</LayerDialog.Title>
          <LayerDialog.Description>{editing ? t("editLead") : t("addLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              {editing === null ? (
                <Input
                  label={t("code")}
                  required
                  maxLength={kCodeMax}
                  className="font-mono"
                  value={draft.code}
                  description={t("codeHint")}
                  error={tried && draft.code.trim() === "" ? common("required") : undefined}
                  onChange={(event) => setDraft({ ...draft, code: event.target.value.toUpperCase() })}
                />
              ) : null}
              <Input
                label={t("name")}
                required
                maxLength={kNameMax}
                value={draft.name}
                error={tried && draft.name.trim() === "" ? common("required") : undefined}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label={t("daysPerYear")}
                  required
                  type="number"
                  min={0}
                  step={0.5}
                  value={draft.daysPerYear}
                  error={tried && draft.daysPerYear === "" ? common("required") : undefined}
                  onChange={(event) => setDraft({ ...draft, daysPerYear: event.target.value })}
                />
                <Input
                  label={optional(t("carryOverMax"))}
                  type="number"
                  min={0}
                  step={0.5}
                  value={draft.carryOverMax}
                  onChange={(event) => setDraft({ ...draft, carryOverMax: event.target.value })}
                />
              </div>
              <Checkbox checked={draft.paid} onCheckedChange={(next) => setDraft({ ...draft, paid: next === true })} label={t("paid")} />
              <div className="flex flex-col gap-1">
                <Checkbox
                  checked={draft.calendarDays}
                  onCheckedChange={(next) => setDraft({ ...draft, calendarDays: next === true })}
                  label={t("calendarDays")}
                />
                <p className="ps-6 text-sm text-kumo-subtle">{t("calendarDaysHint")}</p>
              </div>
              {fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null}
            </div>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary loading={save.isPending} onClick={submit}>
              {editing ? t("save") : t("add")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Alert open={retiring !== null} onOpenChange={(next) => !next && setRetiring(null)} dismissDisabled={flip.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{retiring ? t("retireTitle", { name: retiring.name }) : t("retire")}</LayerDialog.Title>
          <LayerDialog.Description>{t("retireLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <p className="text-kumo-subtle">{t("retireHint")}</p>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary variant="destructive" loading={flip.isPending} onClick={() => retiring && flip.mutate(retiring)}>
              {t("retire")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </>
  );
}
