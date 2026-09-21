"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";

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
  validFrom: string;
  validTo: string | null;
}

interface Employee {
  id: number;
  code: string;
  fullName: string;
}

const WRITERS = ["ADMIN", "HR"];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function ShiftsPage() {
  const t = useTranslations("shifts");
  const common = useTranslations("common");
  const cache = useQueryClient();
  const role = useSession((s) => s.role);
  const faultOf = useFault();
  const mayWrite = role !== null && WRITERS.includes(role);

  const [editing, setEditing] = useState<Shift | null>(null);
  const [adding, setAdding] = useState(false);
  const [rostering, setRostering] = useState<Shift | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [startTime, setStartTime] = useState("08:00");
  const [endTime, setEndTime] = useState("17:30");
  const [graceMinutes, setGraceMinutes] = useState("0");
  const [code, setCode] = useState("");
  const [validFrom, setValidFrom] = useState(today);
  const [validTo, setValidTo] = useState("");

  const shifts = useQuery({
    queryKey: ["shifts"],
    queryFn: async () => (await api.get<Shift[]>("/shifts")).data,
  });

  const assignments = useQuery({
    queryKey: ["shifts", rostering?.id, "assignments"],
    enabled: rostering !== null,
    queryFn: async () =>
      (await api.get<Assignment[]>(`/shifts/${rostering?.id}/assignments`)).data,
  });

  const people = useQuery({
    queryKey: ["employees", "for-shift", code],
    enabled: rostering !== null && code.length >= 2,
    queryFn: async () =>
      (await api.get<{ rows: Employee[] }>(`/employees?search=${encodeURIComponent(code)}&take=10`))
        .data.rows,
  });

  function refresh(): void {
    void cache.invalidateQueries({ queryKey: ["shifts"] });
  }

  const save = useMutation({
    mutationFn: () => {
      const body = { name, startTime, endTime, graceMinutes: Number(graceMinutes) };
      return editing ? api.patch(`/shifts/${editing.id}`, body) : api.post("/shifts", body);
    },
    onSuccess: () => {
      setAdding(false);
      setEditing(null);
      refresh();
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const retire = useMutation({
    mutationFn: (one: Shift) => api.delete(`/shifts/${one.id}`),
    onSuccess: refresh,
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const assign = useMutation({
    mutationFn: (employeeId: number) =>
      api.post(`/shifts/${rostering?.id}/assignments`, {
        employeeId,
        validFrom: new Date(`${validFrom}T00:00:00.000Z`).toISOString(),
        ...(validTo ? { validTo: new Date(`${validTo}T00:00:00.000Z`).toISOString() } : {}),
      }),
    onSuccess: () => {
      setCode("");
      void cache.invalidateQueries({ queryKey: ["shifts"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const unassign = useMutation({
    mutationFn: (one: Assignment) =>
      api.delete(`/shifts/${rostering?.id}/assignments/${one.id}`),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["shifts"] }),
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function open(one: Shift | null): void {
    setFault(null);
    setName(one?.name ?? "");
    setStartTime(one?.startTime ?? "08:00");
    setEndTime(one?.endTime ?? "17:30");
    setGraceMinutes(String(one?.graceMinutes ?? 0));
    setEditing(one);
    setAdding(one === null);
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    setFault(null);
    save.mutate();
  }

  const columns: Column<Shift>[] = [
    { id: "name", header: t("name"), sticky: true, sortBy: (row) => row.name, cell: (row) => row.name },
    {
      id: "startTime",
      header: t("startTime"),
      numeric: true,
      sortBy: (row) => row.startTime,
      cell: (row) => row.startTime,
    },
    { id: "endTime", header: t("endTime"), numeric: true, cell: (row) => row.endTime },
    {
      id: "graceMinutes",
      header: t("graceMinutes"),
      numeric: true,
      sortBy: (row) => row.graceMinutes,
      cell: (row) => row.graceMinutes,
    },
    {
      id: "status",
      header: t("status"),
      sortBy: (row) => (row.active ? 1 : 0),
      cell: (row) => (
        <span className={row.active ? "text-(--color-ok)" : "text-(--color-muted)"}>
          {row.active ? t("active") : t("retired")}
        </span>
      ),
    },
    {
      id: "act",
      header: t("act"),
      cell: (row) =>
        mayWrite ? (
          <span className="flex flex-wrap gap-1">
            <Button
              type="button"
              tone="quiet"
              size="sm"
              onClick={() => {
                setFault(null);
                setRostering(row);
              }}
            >
              {t("roster")}
            </Button>
            <Button type="button" tone="quiet" size="sm" onClick={() => open(row)}>
              {t("edit")}
            </Button>
            {row.active ? (
              <Button
                type="button"
                tone="quiet"
                size="sm"
                disabled={retire.isPending}
                onClick={() => retire.mutate(row)}
              >
                {t("retire")}
              </Button>
            ) : null}
          </span>
        ) : (
          common("empty")
        ),
    },
  ];

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 mb-4 text-sm text-(--color-muted)">{t("lead")}</p>

      {mayWrite ? (
        <Button type="button" className="mb-3" onClick={() => open(null)}>
          {t("add")}
        </Button>
      ) : null}

      {fault ? (
        <p role="alert" className="mb-3 text-sm text-(--color-danger)">
          {fault}
        </p>
      ) : null}

      <DataTable
        id="shifts"
        columns={columns}
        rows={shifts.data}
        keyOf={(row) => row.id}
        pending={shifts.isPending}
        failed={shifts.isError}
        onRetry={() => shifts.refetch()}
      />

      <Sheet
        open={adding || editing !== null}
        onClose={() => {
          setAdding(false);
          setEditing(null);
        }}
        title={editing ? t("edit") : t("add")}
        closeLabel={common("close")}
      >
        <form onSubmit={submit}>
          <label className="block text-sm font-medium" htmlFor="shiftName">
            {t("name")}
          </label>
          <Input
            id="shiftName"
            required
            maxLength={64}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-1"
          />

          <div className="mt-4 flex gap-3">
            <div className="flex-1">
              <label className="block text-sm font-medium" htmlFor="shiftStart">
                {t("startTime")}
              </label>
              <Input
                id="shiftStart"
                type="time"
                required
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
                className="mt-1"
              />
            </div>
            <div className="flex-1">
              <label className="block text-sm font-medium" htmlFor="shiftEnd">
                {t("endTime")}
              </label>
              <Input
                id="shiftEnd"
                type="time"
                required
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
                className="mt-1"
              />
            </div>
          </div>

          <label className="mt-4 block text-sm font-medium" htmlFor="shiftGrace">
            {t("graceMinutes")}
          </label>
          <Input
            id="shiftGrace"
            type="number"
            min={0}
            value={graceMinutes}
            onChange={(event) => setGraceMinutes(event.target.value)}
            className="mt-1"
          />
          <p className="mt-1 text-xs text-(--color-muted)">{t("graceHint")}</p>

          {fault ? (
            <p role="alert" className="mt-3 text-sm text-(--color-danger)">
              {fault}
            </p>
          ) : null}
          <Button type="submit" disabled={save.isPending} className="mt-4">
            {save.isPending ? common("saving") : common("save")}
          </Button>
        </form>
      </Sheet>

      <Sheet
        open={rostering !== null}
        onClose={() => setRostering(null)}
        title={rostering ? `${rostering.name} · ${t("roster")}` : t("roster")}
        closeLabel={common("close")}
        className="sm:max-w-xl"
      >
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-xs text-(--color-muted)" htmlFor="shiftFrom">
              {t("validFrom")}
            </label>
            <Input
              id="shiftFrom"
              type="date"
              value={validFrom}
              onChange={(event) => setValidFrom(event.target.value)}
              className="mt-1"
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-(--color-muted)" htmlFor="shiftTo">
              {t("validTo")}
            </label>
            <Input
              id="shiftTo"
              type="date"
              value={validTo}
              onChange={(event) => setValidTo(event.target.value)}
              className="mt-1"
            />
          </div>
        </div>

        <label className="mt-4 block text-sm font-medium" htmlFor="shiftWho">
          {t("who")}
        </label>
        <Input
          id="shiftWho"
          value={code}
          placeholder={t("whoHint")}
          onChange={(event) => setCode(event.target.value)}
          className="mt-1"
        />
        {(people.data ?? []).length > 0 ? (
          <ul className="mt-2 flex flex-col">
            {(people.data ?? []).map((one) => (
              <li
                key={one.id}
                className="flex items-center gap-3 border-b border-(--color-line) py-2 text-sm last:border-0"
              >
                <span className="min-w-0 flex-1 truncate">{one.fullName}</span>
                <span className="font-mono text-xs text-(--color-muted)">{one.code}</span>
                <Button
                  type="button"
                  size="sm"
                  disabled={assign.isPending}
                  onClick={() => assign.mutate(one.id)}
                >
                  {t("assign")}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        <h3 className="mt-6 text-sm font-medium">{t("assigned")}</h3>
        {assignments.isPending ? (
          <p className="px-4 py-6 text-sm text-(--color-muted)">{common("loading")}</p>
        ) : assignments.data?.length ? (
          <ul className="mt-2 flex flex-col">
            {assignments.data.map((one) => (
              <li
                key={one.id}
                className="flex items-center gap-3 border-b border-(--color-line) py-2 text-sm last:border-0"
              >
                <span className="tabular-nums">
                  {one.validFrom.slice(0, 10)} → {one.validTo ? one.validTo.slice(0, 10) : "—"}
                </span>
                <span className="ms-auto font-mono text-xs text-(--color-muted)">
                  #{one.employeeId}
                </span>
                <Button
                  type="button"
                  tone="quiet"
                  size="sm"
                  disabled={unassign.isPending}
                  onClick={() => unassign.mutate(one)}
                >
                  {t("unassign")}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-(--color-muted)">
            {assignments.isPending ? common("loading") : t("noneAssigned")}
          </p>
        )}

        {fault ? (
          <p role="alert" className="mt-3 text-sm text-(--color-danger)">
            {fault}
          </p>
        ) : null}
      </Sheet>
    </section>
  );
}
