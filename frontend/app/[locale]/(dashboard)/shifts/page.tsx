"use client";

import { Banner, Button, Checkbox, Empty, Input, InputGroup, LayerCard, LayerDialog } from "@cloudflare/kumo";
import {
  ArrowCounterClockwiseIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  ProhibitIcon,
  UserMinusIcon,
  UsersThreeIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Suspense, useState } from "react";

import { DataTable, PagingRow, type Column, type RowAction } from "@/components/tables/data-table";
import { DateField } from "@/components/ui/date-field";
import { Failed } from "@/components/ui/failed";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { useNotify } from "@/components/ui/notify";
import { PageHeader, PageLayout } from "@/components/ui/page";
import { PersonPicker, type Person } from "@/components/ui/person-picker";
import { StatePill } from "@/components/ui/pill";
import { SkeletonLine } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { clockOf, dayOnly } from "@/lib/format";
import { useUrlState } from "@/lib/url-state";

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
  employee: { id: number; code: string; fullName: string; department: { id: string; name: string } | null };
  validFrom: string;
  validTo: string | null;
}

interface AssignmentPage {
  rows: Assignment[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
}

const WRITERS = ["ADMIN", "HR"];
const kRosterPage = 50;
const kNameMax = 64;
const kBulkMax = 500;

function localDay(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

export default function ShiftsPage() {
  return (
    <Suspense>
      <Shifts />
    </Suspense>
  );
}

function Shifts() {
  const locale = useLocale();
  const t = useTranslations("shifts");
  const shared = useTranslations("catalogues");
  const common = useTranslations("common");
  const format = useFormatter();
  const cache = useQueryClient();
  const role = useSession((s) => s.role);
  const faultOf = useFault();
  const notify = useNotify();
  const mayWrite = role !== null && WRITERS.includes(role);

  const [url, setUrl] = useUrlState({ retired: "" });
  const [editing, setEditing] = useState<Shift | null>(null);
  const [adding, setAdding] = useState(false);
  const [tried, setTried] = useState(false);
  const [rostering, setRostering] = useState<Shift | null>(null);
  const [retiring, setRetiring] = useState<Shift | null>(null);
  const [dropping, setDropping] = useState<Assignment | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [startTime, setStartTime] = useState("08:00");
  const [endTime, setEndTime] = useState("17:30");
  const [graceMinutes, setGraceMinutes] = useState("0");
  const [chosen, setChosen] = useState<Person[]>([]);
  const [validFrom, setValidFrom] = useState(() => localDay(new Date()));
  const [validTo, setValidTo] = useState("");
  const [rosterTyped, setRosterTyped] = useState("");
  const rosterSearch = useSettled(rosterTyped.trim());

  const shifts = useQuery({
    queryKey: ["shifts"],
    queryFn: async () => (await api.get<Shift[]>("/shifts")).data,
  });

  const assignments = useInfiniteQuery({
    queryKey: ["shifts", rostering?.id, "assignments", rosterSearch],
    enabled: rostering !== null,
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({ take: String(kRosterPage) });
      if (rosterSearch) {
        params.set("search", rosterSearch);
      }
      if (pageParam) {
        params.set("cursor", pageParam);
      }
      return (await api.get<AssignmentPage>(`/shifts/${rostering?.id}/assignments?${params.toString()}`)).data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

  function refresh(): void {
    void cache.invalidateQueries({ queryKey: ["shifts"] });
  }

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), startTime, endTime, graceMinutes: Number(graceMinutes || "0") };
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
    mutationFn: async (people: Person[]) =>
      (
        await api.post<{ assigned: number; skipped: unknown[] }>(`/shifts/${rostering?.id}/assignments/bulk?apply=true`, {
          employeeIds: people.map((one) => one.id),
          validFrom: new Date(`${validFrom}T00:00:00.000Z`).toISOString(),
          ...(validTo ? { validTo: new Date(`${validTo}T00:00:00.000Z`).toISOString() } : {}),
        })
      ).data,
    onSuccess: (done) => {
      notify.done(
        t("assignedMany", { count: done.assigned, shift: rostering?.name ?? "" }),
        done.skipped.length > 0 ? t("assignedSkipped", { count: done.skipped.length }) : undefined,
      );
      setChosen([]);
      setTried(false);
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
    setTried(false);
    setName(one?.name ?? "");
    setStartTime(one?.startTime ?? "08:00");
    setEndTime(one?.endTime ?? "17:30");
    setGraceMinutes(String(one?.graceMinutes ?? 0));
    setEditing(one);
    setAdding(one === null);
  }

  function openRoster(one: Shift): void {
    setFault(null);
    setTried(false);
    setChosen([]);
    setRosterTyped("");
    setValidFrom(localDay(new Date()));
    setValidTo("");
    setRostering(one);
  }

  function pickPerson(next: Person | null): void {
    if (next && !chosen.some((one) => one.id === next.id) && chosen.length < kBulkMax) {
      setChosen([...chosen, next]);
    }
  }

  function submitShift(): void {
    setTried(true);
    if (name.trim() === "" || startTime === "" || endTime === "") {
      return;
    }
    setFault(null);
    save.mutate();
  }

  function submitRoster(): void {
    setTried(true);
    if (chosen.length === 0 || validFrom === "") {
      return;
    }
    setFault(null);
    assign.mutate(chosen);
  }

  const shown = shifts.data?.filter((one) => url.retired === "1" || one.active);
  const hours = (one: Shift) => `${clockOf(one.startTime, locale)} – ${clockOf(one.endTime, locale)}`;
  const faultBanner = fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null;
  const rosterRows = assignments.data?.pages.flatMap((one) => one.rows);
  const firstRoster = assignments.data?.pages[0];

  const columns: Column<Shift>[] = [
    { id: "name", header: t("name"), cell: (row) => <span className="font-medium">{row.name}</span> },
    { id: "startTime", header: t("startTime"), numeric: true, cell: (row) => clockOf(row.startTime, locale) },
    { id: "endTime", header: t("endTime"), numeric: true, cell: (row) => clockOf(row.endTime, locale) },
    { id: "graceMinutes", header: t("graceMinutes"), numeric: true, priority: 2, cell: (row) => row.graceMinutes },
    {
      id: "status",
      header: t("status"),
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
          id="shifts"
          cardLead="name"
          cardTrailing="status"
          columns={columns}
          rows={shown}
          keyOf={(row) => row.id}
          pending={shifts.isPending}
          failed={shifts.isError}
          onRetry={() => void shifts.refetch()}
          onRowClick={mayWrite ? openForm : undefined}
          rowActions={mayWrite ? actionsOf : undefined}
          empty={t("empty")}
          emptyHint={t("emptyHint")}
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
          <LayerDialog.Title>{editing ? t("editTitle", { name: editing.name }) : t("add")}</LayerDialog.Title>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              <Input
                label={t("name")}
                required
                maxLength={kNameMax}
                value={name}
                error={tried && name.trim() === "" ? common("required") : undefined}
                onChange={(event) => setName(event.target.value)}
              />
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label={t("startTime")}
                  type="time"
                  required
                  value={startTime}
                  error={tried && startTime === "" ? common("required") : undefined}
                  onChange={(event) => setStartTime(event.target.value)}
                />
                <Input
                  label={t("endTime")}
                  type="time"
                  required
                  value={endTime}
                  error={tried && endTime === "" ? common("required") : undefined}
                  onChange={(event) => setEndTime(event.target.value)}
                />
              </div>
              <Input
                label={t("graceMinutes")}
                type="number"
                min={0}
                value={graceMinutes}
                description={t("graceHint")}
                onChange={(event) => setGraceMinutes(event.target.value)}
              />
              {faultBanner}
            </div>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary loading={save.isPending} onClick={submitShift}>
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
              <PersonPicker
                label={t("who")}
                description={t("whoManyHint")}
                error={tried && chosen.length === 0 ? t("whoMissing") : undefined}
                value={null}
                onChange={pickPerson}
              />
              {chosen.length > 0 ? (
                <ul className="flex flex-wrap gap-2" aria-label={t("chosenPeople")}>
                  {chosen.map((one) => (
                    <li key={one.id} className="flex items-center gap-1 rounded-full border border-kumo-line py-0.5 ps-3 pe-1 text-sm">
                      <span className="max-w-48 truncate">{one.fullName}</span>
                      <span className="font-mono text-kumo-subtle">{one.code}</span>
                      <Button
                        variant="ghost"
                        size="xs"
                        shape="square"
                        icon={XIcon}
                        aria-label={t("unchoose", { name: one.fullName })}
                        onClick={() => setChosen(chosen.filter((held) => held.id !== one.id))}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="grid items-start gap-4 sm:grid-cols-2">
                <DateField
                  label={t("validFrom")}
                  value={validFrom}
                  error={tried && validFrom === "" ? common("required") : undefined}
                  onChange={setValidFrom}
                />
                <DateField
                  label={t("validTo")}
                  required={false}
                  min={validFrom || undefined}
                  value={validTo}
                  description={t("validToHint")}
                  onChange={setValidTo}
                />
              </div>
              {faultBanner}

              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold">
                    {t("assigned")}
                    {firstRoster ? <span className="ms-2 font-normal text-kumo-subtle tabular-nums">{format.number(firstRoster.total)}</span> : null}
                  </h3>
                  <InputGroup className="min-w-0 basis-56">
                    <InputGroup.Addon>
                      <MagnifyingGlassIcon />
                    </InputGroup.Addon>
                    <InputGroup.Input
                      type="search"
                      value={rosterTyped}
                      placeholder={t("rosterSearchHint")}
                      aria-label={t("rosterSearchHint")}
                      onChange={(event) => setRosterTyped(event.target.value)}
                    />
                  </InputGroup>
                </div>
                {assignments.isError ? (
                  <Failed onRetry={() => void assignments.refetch()} />
                ) : assignments.isPending ? (
                  <div className="flex flex-col gap-3 py-2">
                    <SkeletonLine minWidth={27} maxWidth={60} />
                    <SkeletonLine minWidth={27} maxWidth={60} />
                  </div>
                ) : !rosterRows || rosterRows.length === 0 ? (
                  <Empty
                    size="sm"
                    icon={<UsersThreeIcon size={32} className="text-kumo-inactive" />}
                    title={rosterSearch ? t("noneAssignedMatch") : t("noneAssigned")}
                  />
                ) : (
                  <LayerCard className="p-0">
                    <ul className="flex flex-col">
                      {rosterRows.map((one) => (
                        <li key={one.id} className="flex items-center gap-3 border-b border-kumo-hairline px-3 py-2 last:border-0">
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate">
                              {one.employee.fullName}
                              <span className="ms-2 font-mono text-sm text-kumo-subtle">{one.employee.code}</span>
                            </span>
                            <span className="truncate text-sm text-kumo-subtle tabular-nums">
                              {one.employee.department ? `${one.employee.department.name} · ` : ""}
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
                    {firstRoster ? (
                      <PagingRow
                        paging={{
                          shown: rosterRows.length,
                          total: firstRoster.total,
                          exact: firstRoster.totalIsExact,
                          onMore: assignments.hasNextPage ? () => void assignments.fetchNextPage() : undefined,
                          loading: assignments.isFetchingNextPage,
                        }}
                      />
                    ) : null}
                  </LayerCard>
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
            <LayerDialog.Actions.Primary loading={assign.isPending} onClick={submitRoster}>
              {chosen.length > 0 ? t("assignMany", { count: chosen.length }) : t("assign")}
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
