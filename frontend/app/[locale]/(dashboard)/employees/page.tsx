"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { DataTable, type Column } from "@/components/tables/data-table";
import { api } from "@/lib/api";

interface Employee {
  id: number;
  code: string;
  fullName: string;
  department: string | null;
  active: boolean;
}

export default function EmployeesPage() {
  const t = useTranslations("employees");
  const common = useTranslations("common");
  const employees = useQuery({
    queryKey: ["employees"],
    queryFn: async () =>
      (await api.get<{ rows: Employee[]; total: number }>("/employees")).data,
  });

  const columns: Column<Employee>[] = [
    { header: t("code"), cell: (row) => <span className="font-mono">{row.code}</span> },
    { header: t("fullName"), cell: (row) => row.fullName },
    { header: t("department"), cell: (row) => row.department ?? common("empty") },
    {
      header: t("status"),
      cell: (row) => (
        <span className={row.active ? "text-(--color-ok)" : "text-(--color-muted)"}>
          {row.active ? t("working") : t("left")}
        </span>
      ),
    },
  ];

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">
        {employees.data ? t("count", { count: employees.data.total }) : " "}
      </p>
      <DataTable
        columns={columns}
        rows={employees.data?.rows}
        keyOf={(row) => String(row.id)}
        pending={employees.isPending}
      />
    </section>
  );
}
