"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";

interface Department {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  costCentre: string | null;
  legalEntityId: string;
}

interface Holiday {
  id: string;
  date: string;
  name: string;
  paid: boolean;
}

interface Entity {
  id: string;
  name: string;
}

function thisYear(): number {
  return new Date().getUTCFullYear();
}

export default function DepartmentsPage() {
  const t = useTranslations("org");
  const common = useTranslations("common");
  const role = useSession((s) => s.role);
  const mayWrite = role === "ADMIN" || role === "HR";
  const cache = useQueryClient();
  const faultOf = useFault();

  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [holidayName, setHolidayName] = useState("");
  const [holidayDate, setHolidayDate] = useState("");
  const [holidayPaid, setHolidayPaid] = useState(true);
  const [fault, setFault] = useState<string | null>(null);
  // Taking a public holiday away rebuilds that day for everybody, so the
  // second click is the confirmation.
  const [dropping, setDropping] = useState<string | null>(null);

  const entities = useQuery({
    queryKey: ["legal-entities"],
    queryFn: async () => (await api.get<Entity[]>("/legal-entities")).data,
  });

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Department[]>("/departments")).data,
  });

  const holidays = useQuery({
    queryKey: ["holidays", thisYear()],
    queryFn: async () => (await api.get<Holiday[]>(`/holidays?year=${thisYear()}`)).data,
  });

  const addDepartment = useMutation({
    mutationFn: () =>
      api.post("/departments", {
        legalEntityId: entities.data?.[0]?.id,
        name,
        parentId: parentId || undefined,
      }),
    onSuccess: () => {
      setName("");
      setParentId("");
      void cache.invalidateQueries({ queryKey: ["departments"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const addHoliday = useMutation({
    mutationFn: () =>
      api.post("/holidays", { date: holidayDate, name: holidayName, paid: holidayPaid }),
    onSuccess: () => {
      setHolidayName("");
      setHolidayDate("");
      void cache.invalidateQueries({ queryKey: ["holidays"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const dropHoliday = useMutation({
    mutationFn: (id: string) => api.delete(`/holidays/${id}`),
    onSuccess: () => {
      setDropping(null);
      void cache.invalidateQueries({ queryKey: ["holidays"] });
    },
  });

  const nameOf = new Map((departments.data ?? []).map((one) => [one.id, one.name]));

  const columns: Column<Department>[] = [
    {
      id: "code",
      header: t("code"),
      sticky: true,
      sortBy: (row) => row.code,
      cell: (row) => <span className="font-mono">{row.code}</span>,
    },
    { id: "name", header: t("name"), sortBy: (row) => row.name, cell: (row) => row.name },
    {
      id: "parent",
      header: t("parent"),
      cell: (row) => (row.parentId ? (nameOf.get(row.parentId) ?? common("empty")) : t("noParent")),
    },
    {
      id: "costCentre",
      header: t("costCentre"),
      cell: (row) => row.costCentre ?? common("empty"),
    },
  ];

  return (
    <section>
      <h1 className="mt-2 text-lg font-semibold">{t("departments")}</h1>
      <p className="mt-1 mb-4 text-sm text-(--color-muted)">{t("departmentsLead")}</p>

      {mayWrite ? (
        <form
          className="mb-4 flex flex-wrap items-end gap-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            setFault(null);
            addDepartment.mutate();
          }}
        >
          <Input
            aria-label={t("name")}
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="min-w-48 flex-1"
          />
          <Select
            aria-label={t("parent")}
            value={parentId}
            onChange={(event) => setParentId(event.target.value)}
            className="w-56"
          >
            <option value="">{t("noParent")}</option>
            {(departments.data ?? []).map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </Select>
          <Button type="submit" disabled={addDepartment.isPending}>
            {addDepartment.isPending ? common("saving") : t("newDepartment")}
          </Button>
        </form>
      ) : null}

      {fault ? (
        <p role="alert" className="mb-3 text-sm text-(--color-danger)">
          {fault}
        </p>
      ) : null}

      <DataTable
        id="departments"
        columns={columns}
        rows={departments.data}
        keyOf={(row) => row.id}
        pending={departments.isPending}
        failed={departments.isError}
        onRetry={() => departments.refetch()}
      />

      <h2 className="mt-8 text-sm font-semibold">{t("holidays")}</h2>
      <p className="mt-1 text-sm text-(--color-muted)">{t("holidaysLead")}</p>

      {mayWrite ? (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            setFault(null);
            addHoliday.mutate();
          }}
        >
          <Input
            aria-label={t("holidayDate")}
            type="date"
            required
            value={holidayDate}
            onChange={(event) => setHolidayDate(event.target.value)}
            className="w-44"
          />
          <Input
            aria-label={t("holidayName")}
            required
            maxLength={120}
            value={holidayName}
            onChange={(event) => setHolidayName(event.target.value)}
            className="min-w-48 flex-1"
          />
          <Checkbox
            checked={holidayPaid}
            onChange={(event) => setHolidayPaid(event.target.checked)}
            label={t("holidayPaid")}
          />
          <Button type="submit" disabled={addHoliday.isPending}>
            {addHoliday.isPending ? common("saving") : t("addHoliday")}
          </Button>
        </form>
      ) : null}

      <div className="mt-3 flex flex-col gap-2">
        {holidays.isPending ? (
          <p className="px-4 py-6 text-sm text-(--color-muted)">{common("loading")}</p>
        ) : holidays.data?.length ? (
          holidays.data.map((row) => (
            <article
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-(--color-line) bg-(--color-surface) p-3 text-sm"
            >
              <span className="tabular-nums">{row.date.slice(0, 10)}</span>
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              <span className="text-xs text-(--color-muted)">
                {row.paid ? t("holidayPaid") : common("no")}
              </span>
              {mayWrite ? (
                <Button
                  type="button"
                  tone={dropping === row.id ? "danger" : "quiet"}
                  size="sm"
                  disabled={dropHoliday.isPending}
                  onClick={() =>
                    dropping === row.id ? dropHoliday.mutate(row.id) : setDropping(row.id)
                  }
                  onBlur={() => setDropping(null)}
                >
                  {dropping === row.id ? common("sure") : t("removeHoliday")}
                </Button>
              ) : null}
            </article>
          ))
        ) : (
          <p className="text-sm text-(--color-muted)">{t("holidaysEmpty")}</p>
        )}
      </div>
    </section>
  );
}
