"use client";

import { Button, Checkbox, Input, LayerDialog } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, PlusIcon, ProhibitIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { NextHoliday } from "@/components/holidays/next-holiday";
import { DataTable, type Column, type RowAction } from "@/components/tables/data-table";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, PageHeader, PageLayout, StatList } from "@/components/ui/page";
import { StatePill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";

interface LeaveType {
  id: string;
  code: string;
  name: string;
  paid: boolean;
  daysPerYear: string;
  carryOverMax: string;
  active: boolean;
}

interface Draft {
  code: string;
  name: string;
  paid: boolean;
  daysPerYear: string;
  carryOverMax: string;
}

type Standing = "active" | "retired" | "";

const kBlank: Draft = { code: "", name: "", paid: true, daysPerYear: "", carryOverMax: "0" };

export default function LeaveTypesPage() {
  const t = useTranslations("leaveTypes");
  const common = useTranslations("common");
  const role = useSession((s) => s.role);
  const mayWrite = role === "ADMIN" || role === "HR";
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();

  const [standing, setStanding] = useState<Standing>("active");
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
    setDraft(
      one
        ? {
            code: one.code,
            name: one.name,
            paid: one.paid,
            daysPerYear: String(Number(one.daysPerYear)),
            carryOverMax: String(Number(one.carryOverMax)),
          }
        : kBlank,
    );
    setEditing(one);
    setAdding(one === null);
  }

  const all = types.data ?? [];
  const working = all.filter((one) => one.active).length;
  const shown = types.data?.filter((one) => (standing === "" ? true : standing === "active" ? one.active : !one.active));

  const columns: Column<LeaveType>[] = [
    { id: "code", header: t("code"), sticky: true, sortBy: (row) => row.code, cell: (row) => <span className="font-mono">{row.code}</span> },
    {
      id: "name",
      header: t("name"),
      sortBy: (row) => row.name,
      cell: (row) => (
        <span className="flex items-center gap-2 whitespace-nowrap">
          {row.name}
          {row.active ? null : <StatePill>{t("retiredPill")}</StatePill>}
        </span>
      ),
    },
    {
      id: "paid",
      header: t("pay"),
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
      id: "carryOverMax",
      header: t("carryOverShort"),
      numeric: true,
      sortBy: (row) => Number(row.carryOverMax),
      cell: (row) => Number(row.carryOverMax),
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

      <PageLayout
        aside={
          <AsideCard title={common("summary")}>
            <StatList
              stats={[
                {
                  key: "active",
                  label: t("inUseCount"),
                  value: types.data ? working : common("empty"),
                  active: standing === "active",
                  onPick: () => setStanding("active"),
                },
                {
                  key: "retired",
                  label: t("retired"),
                  value: types.data ? all.length - working : common("empty"),
                  active: standing === "retired",
                  onPick: () => setStanding("retired"),
                },
                {
                  key: "all",
                  label: common("all"),
                  value: types.data ? all.length : common("empty"),
                  active: standing === "",
                  onPick: () => setStanding(""),
                },
              ]}
            />
          </AsideCard>
        }
        extra={<NextHoliday />}
      >
        <DataTable
          id="leave-types"
          cardLead="name"
          columns={columns}
          rows={shown}
          keyOf={(row) => row.id}
          pending={types.isPending}
          failed={types.isError}
          onRetry={() => void types.refetch()}
          onRowClick={mayWrite ? openForm : undefined}
          rowActions={mayWrite ? actionsOf : undefined}
          empty={standing === "retired" ? t("noneRetired") : t("empty")}
          emptyAction={
            mayWrite && standing !== "retired" ? (
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
                  maxLength={32}
                  className="font-mono"
                  value={draft.code}
                  description={t("codeHint")}
                  onChange={(event) => setDraft({ ...draft, code: event.target.value.toUpperCase() })}
                />
              ) : null}
              <Input
                label={t("name")}
                required
                maxLength={120}
                value={draft.name}
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
                  onChange={(event) => setDraft({ ...draft, daysPerYear: event.target.value })}
                />
                <Input
                  label={t("carryOverMax")}
                  type="number"
                  min={0}
                  step={0.5}
                  value={draft.carryOverMax}
                  onChange={(event) => setDraft({ ...draft, carryOverMax: event.target.value })}
                />
              </div>
              <Checkbox checked={draft.paid} onCheckedChange={(next) => setDraft({ ...draft, paid: next === true })} label={t("paid")} />
              {fault ? <p role="alert" className="text-kumo-danger">{fault}</p> : null}
            </div>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              loading={save.isPending}
              disabled={draft.name.trim() === "" || draft.daysPerYear === "" || (editing === null && draft.code.trim() === "")}
              onClick={() => {
                setFault(null);
                save.mutate();
              }}
            >
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
