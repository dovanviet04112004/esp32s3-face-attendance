"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { dayOnly } from "@/lib/format";
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

interface Entity {
  id: string;
  name: string;
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
  const [fault, setFault] = useState<string | null>(null);

  const entities = useQuery({
    queryKey: ["legal-entities"],
    queryFn: async () => (await api.get<Entity[]>("/legal-entities")).data,
  });

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Department[]>("/departments")).data,
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
          <label className="block min-w-48 flex-1 text-xs text-(--color-muted)">
            {t("name")}
            <Input
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1"
            />
          </label>
          <label className="block w-56 text-xs text-(--color-muted)">
            {t("parent")}
            <Select
              value={parentId}
              onChange={(event) => setParentId(event.target.value)}
              className="mt-1"
            >
              <option value="">{t("noParent")}</option>
              {(departments.data ?? []).map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                </option>
              ))}
            </Select>
          </label>
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

    </section>
  );
}
