"use client";

import { Button, Empty, Input, LayerDialog, SkeletonLine } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, PlusIcon, ProhibitIcon, UserMinusIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { NextHoliday } from "@/components/holidays/next-holiday";
import { DataTable, type Column, type RowAction } from "@/components/tables/data-table";
import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, PageHeader, PageLayout, StatList } from "@/components/ui/page";
import { PersonPicker, type Person } from "@/components/ui/person-picker";
import { StatePill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { dayOnly } from "@/lib/format";

interface Shift {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  graceMinutes: number;
  active: boolean;
}

interface Assignment {
  id: string;
  employeeId: number;
  employee: { id: number; code: string; fullName: string };
  validFrom: string;
  validTo: string | null;
}

type Standing = "active" | "retired" | "";

const WRITERS = ["ADMIN", "HR"];

function localDay(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

export default function ShiftsPage() {
  const t = useTranslations("shifts");
  const common = useTranslations("common");
  const format = useFormatter();
  const cache = useQueryClient();
  const role = useSession((s) => s.role);
  const faultOf = useFault();
  const notify = useNotify();
  const mayWrite = role !== null && WRITERS.includes(role);

  const [standing, setStanding] = useState<Standing>("active");
  const [editing, setEditing] = useState<Shift | null>(null);
  const [adding, setAdding] = useState(false);
  const [rostering, setRostering] = useState<Shift | null>(null);
  const [retiring, setRetiring] = useState<Shift | null>(null);
  const [dropping, setDropping] = useState<Assignment | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [startTime, setStartTime] = useState("08:00");
  const [endTime, setEndTime] = useState("17:30");
  const [graceMinutes, setGraceMinutes] = useState("0");
  const [picked, setPicked] = useState<Person | null>(null);
  const [validFrom, setValidFrom] = useState(() => localDay(new Date()));
  const [validTo, setValidTo] = useState("");

  const shifts = useQuery({
    queryKey: ["shifts"],
    queryFn: async () => (await api.get<Shift[]>("/shifts")).data,
  });

  const assignments = useQuery({
    queryKey: ["shifts", rostering?.id, "assignments"],
    enabled: rostering !== null,
    queryFn: async () => (await api.get<Assignment[]>(`/shifts/${rostering?.id}/assignments`)).data,
  });

  function refresh(): void {
    void cache.invalidateQueries({ queryKey: ["shifts"] });
  }

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), startTime, endTime, graceMinutes: Number(graceMinutes) };
      return editing ? api.patch(`/shifts/${editing.id}`, body) : api.post("/shifts", body);
    },
    onSuccess: () => {
      notify.done(editing ? t("saved", { name: name.trim() }) : t("added", { name: name.trim() }));
      setAdding(false);
      setEditing(null);
      refresh();
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const retire = useMutation({
    mutationFn: (one: Shift) => api.delete(`/shifts/${one.id}`),
    onSuccess: (_, one) => {
      notify.done(t("retiredDone", { name: one.name }));
      setRetiring(null);
      refresh();
    },
    onError: notify.failed,
  });

  const restore = useMutation({
    mutationFn: (one: Shift) => api.patch(`/shifts/${one.id}`, { active: true }),
    onSuccess: (_, one) => {
      notify.done(t("restoredDone", { name: one.name }));
      refresh();
    },
    onError: notify.failed,
  });

  const assign = useMutation({
    mutationFn: (who: Person) =>
      api.post(`/shifts/${rostering?.id}/assignments`, {
        employeeId: who.id,
        validFrom: new Date(`${validFrom}T00:00:00.000Z`).toISOString(),
        ...(validTo ? { validTo: new Date(`${validTo}T00:00:00.000Z`).toISOString() } : {}),
      }),
    onSuccess: (_, who) => {
      notify.done(t("assignedDone", { name: who.fullName, shift: rostering?.name ?? "" }));
      setPicked(null);
      refresh();
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const unassign = useMutation({
    mutationFn: (one: Assignment) => api.delete(`/shifts/${rostering?.id}/assignments/${one.id}`),
    onSuccess: (_, one) => {
      notify.done(t("unassignedDone", { name: one.employee.fullName, shift: rostering?.name ?? "" }));
      setDropping(null);
      refresh();
    },
    onError: notify.failed,
  });

  function openForm(one: Shift | null): void {
    setFault(null);
    setName(one?.name ?? "");
    setStartTime(one?.startTime ?? "08:00");
    setEndTime(one?.endTime ?? "17:30");
    setGraceMinutes(String(one?.graceMinutes ?? 0));
    setEditing(one);
    setAdding(one === null);
  }

  function openRoster(one: Shift): void {
    setFault(null);
    setPicked(null);
    setValidFrom(localDay(new Date()));
    setValidTo("");
    setRostering(one);
  }

  const all = shifts.data ?? [];
  const working = all.filter((one) => one.active).length;
  const shown = shifts.data?.filter((one) => (standing === "" ? true : standing === "active" ? one.active : !one.active));
  const hours = (one: Shift) => `${one.startTime} – ${one.endTime}`;

  const columns: Column<Shift>[] = [
    { id: "name", header: t("name"), sticky: true, sortBy: (row) => row.name, cell: (row) => <span className="font-medium">{row.name}</span> },
    { id: "startTime", header: t("startTime"), numeric: true, sortBy: (row) => row.startTime, cell: (row) => row.startTime },
    { id: "endTime", header: t("endTime"), numeric: true, sortBy: (row) => row.endTime, cell: (row) => row.endTime },
    { id: "graceMinutes", header: t("graceMinutes"), numeric: true, sortBy: (row) => row.graceMinutes, cell: (row) => row.graceMinutes },
    {
      id: "status",
      header: t("status"),
      sortBy: (row) => (row.active ? 1 : 0),
      cell: (row) => <StatePill tone={row.active ? "good" : "idle"}>{row.active ? t("active") : t("retired")}</StatePill>,
    },
  ];

  function actionsOf(row: Shift): RowAction[] {
    return [
      { key: "roster", label: t("roster"), icon: UsersThreeIcon, onSelect: () => openRoster(row) },
      row.active
        ? { key: "retire", label: t("retire"), icon: ProhibitIcon, danger: true, onSelect: () => setRetiring(row) }
        : { key: "restore", label: t("restore"), icon: ArrowCounterClockwiseIcon, onSelect: () => restore.mutate(row) },
    ];
  }

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("pageLead")}
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
                  label: t("countActive"),
                  value: shifts.data ? working : common("empty"),
                  active: standing === "active",
                  onPick: () => setStanding("active"),
                },
                {
                  key: "retired",
                  label: t("countRetired"),
                  value: shifts.data ? all.length - working : common("empty"),
                  active: standing === "retired",
                  onPick: () => setStanding("retired"),
                },
                {
                  key: "all",
                  label: common("all"),
                  value: shifts.data ? all.length : common("empty"),
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
          id="shifts"
          cardLead="name"
          columns={columns}
          rows={shown}
          keyOf={(row) => row.id}
          pending={shifts.isPending}
          failed={shifts.isError}
          onRetry={() => void shifts.refetch()}
          onRowClick={mayWrite ? openForm : undefined}
          rowActions={mayWrite ? actionsOf : undefined}
          empty={standing === "retired" ? t("noneRetired") : t("empty")}
          emptyHint={standing === "retired" ? undefined : t("emptyHint")}
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
          <LayerDialog.Title>{editing ? t("editTitle", { name: editing.name }) : t("add")}</LayerDialog.Title>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              <Input label={t("name")} required maxLength={64} value={name} onChange={(event) => setName(event.target.value)} />
              <div className="grid grid-cols-2 gap-4">
                <Input label={t("startTime")} type="time" required value={startTime} onChange={(event) => setStartTime(event.target.value)} />
                <Input label={t("endTime")} type="time" required value={endTime} onChange={(event) => setEndTime(event.target.value)} />
              </div>
              <Input
                label={t("graceMinutes")}
                type="number"
                min={0}
                value={graceMinutes}
                description={t("graceHint")}
                onChange={(event) => setGraceMinutes(event.target.value)}
              />
              {fault ? <p role="alert" className="text-kumo-danger">{fault}</p> : null}
            </div>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              loading={save.isPending}
              disabled={name.trim() === "" || startTime === "" || endTime === ""}
              onClick={() => {
                setFault(null);
                save.mutate();
              }}
            >
              {editing ? common("save") : t("add")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Root open={rostering !== null} onOpenChange={(next) => !next && setRostering(null)} dismissDisabled={assign.isPending}>
        <LayerDialog.Content size="lg" closeLabel={common("close")}>
          <LayerDialog.Title>{rostering ? t("rosterTitle", { name: rostering.name }) : t("roster")}</LayerDialog.Title>
          <LayerDialog.Description>{rostering ? t("rosterLead", { hours: hours(rostering) }) : null}</LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              <PersonPicker label={t("who")} value={picked} onChange={setPicked} />
              <div className="grid grid-cols-2 items-start gap-4">
                <Input label={t("validFrom")} type="date" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} />
                <Input
                  label={t("validTo")}
                  type="date"
                  min={validFrom}
                  value={validTo}
                  description={t("validToHint")}
                  onChange={(event) => setValidTo(event.target.value)}
                />
              </div>
              {fault ? <p role="alert" className="text-kumo-danger">{fault}</p> : null}

              <div>
                <h3 className="mb-1 font-semibold">{t("assigned")}</h3>
                {assignments.isError ? (
                  <Failed onRetry={() => void assignments.refetch()} />
                ) : assignments.isPending ? (
                  <div className="flex flex-col gap-3 py-2">
                    <SkeletonLine minWidth={27} maxWidth={60} />
                    <SkeletonLine minWidth={27} maxWidth={60} />
                  </div>
                ) : assignments.data.length === 0 ? (
                  <Empty size="sm" icon={<UsersThreeIcon size={32} className="text-kumo-inactive" />} title={t("noneAssigned")} />
                ) : (
                  <ul className="flex flex-col">
                    {assignments.data.map((one) => (
                      <li key={one.id} className="flex items-center gap-3 border-b border-kumo-hairline py-2 last:border-0">
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate">
                            {one.employee.fullName}
                            <span className="ms-2 font-mono text-sm text-kumo-subtle">{one.employee.code}</span>
                          </span>
                          <span className="text-sm text-kumo-subtle tabular-nums">
                            {format.dateTime(dayOnly(one.validFrom), "day")} →{" "}
                            {one.validTo ? format.dateTime(dayOnly(one.validTo), "day") : t("openEnded")}
                          </span>
                        </span>
                        <Button
                          variant="ghost"
                          shape="square"
                          icon={UserMinusIcon}
                          aria-label={t("unassignOf", { name: one.employee.fullName })}
                          onClick={() => setDropping(one)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <LayerDialog.Alert open={dropping !== null} onOpenChange={(next) => !next && setDropping(null)} dismissDisabled={unassign.isPending}>
              <LayerDialog.Content size="sm" closeLabel={common("close")}>
                <LayerDialog.Title>{t("unassignTitle")}</LayerDialog.Title>
                <LayerDialog.Description>
                  {dropping && rostering ? t("unassignLead", { name: dropping.employee.fullName, shift: rostering.name }) : null}
                </LayerDialog.Description>
                <LayerDialog.Body>
                  <p className="text-kumo-subtle">{t("unassignHint")}</p>
                </LayerDialog.Body>
                <LayerDialog.Actions dismissLabel={common("cancel")}>
                  <LayerDialog.Actions.Primary
                    variant="destructive"
                    loading={unassign.isPending}
                    onClick={() => dropping && unassign.mutate(dropping)}
                  >
                    {t("unassign")}
                  </LayerDialog.Actions.Primary>
                </LayerDialog.Actions>
              </LayerDialog.Content>
            </LayerDialog.Alert>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("close")}>
            <LayerDialog.Actions.Primary
              loading={assign.isPending}
              disabled={picked === null || validFrom === ""}
              onClick={() => {
                if (picked) {
                  setFault(null);
                  assign.mutate(picked);
                }
              }}
            >
              {picked ? t("assignOf", { name: picked.fullName }) : t("assign")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Alert open={retiring !== null} onOpenChange={(next) => !next && setRetiring(null)} dismissDisabled={retire.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{retiring ? t("retireTitle", { name: retiring.name }) : t("retire")}</LayerDialog.Title>
          <LayerDialog.Description>{retiring ? t("retireLead", { name: retiring.name }) : null}</LayerDialog.Description>
          <LayerDialog.Body>
            {retiring ? (
              <p className="text-kumo-subtle tabular-nums">
                {t("retireFacts", { hours: hours(retiring), grace: retiring.graceMinutes })}
              </p>
            ) : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary variant="destructive" loading={retire.isPending} onClick={() => retiring && retire.mutate(retiring)}>
              {t("retire")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </>
  );
}
