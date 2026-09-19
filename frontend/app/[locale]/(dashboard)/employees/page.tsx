"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { DataTable, type Column } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";

interface Employee {
  id: number;
  code: string;
  fullName: string;
  department: { id: string; name: string } | null;
  active: boolean;
}

export default function EmployeesPage() {
  const t = useTranslations("employees");
  const common = useTranslations("common");
  const role = useSession((s) => s.role);
  const mayWrite = role === "ADMIN" || role === "HR";
  const employees = useQuery({
    queryKey: ["employees"],
    queryFn: async () =>
      (await api.get<{ rows: Employee[]; total: number }>("/employees")).data,
  });

  const columns: Column<Employee>[] = [
    { header: t("code"), cell: (row) => <span className="font-mono">{row.code}</span> },
    { header: t("fullName"), cell: (row) => row.fullName },
    { header: t("department"), cell: (row) => row.department?.name ?? common("empty") },
    {
      header: t("status"),
      cell: (row) => (
        <span className={row.active ? "text-(--color-ok)" : "text-(--color-muted)"}>
          {row.active ? t("working") : t("left")}
        </span>
      ),
    },
  ];

  if (mayWrite) {
    columns.push({
      header: "",
      cell: (row) => (
        <Link
          href={`/employees/${row.id}`}
          className="text-(--color-accent) hover:underline"
        >
          {t("edit")}
        </Link>
      ),
    });
  }

  return (
    <section>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-lg font-semibold">{t("title")}</h1>
          <p className="mt-1 mb-6 text-sm text-(--color-muted)">
            {employees.data ? t("count", { count: employees.data.total }) : " "}
          </p>
        </div>
        {mayWrite ? (
          <Link href="/employees/new">
            <Button size="sm">{t("new")}</Button>
          </Link>
        ) : null}
      </div>
      <DataTable
        columns={columns}
        rows={employees.data?.rows}
        keyOf={(row) => String(row.id)}
        pending={employees.isPending}
      />
    </section>
  );
}
