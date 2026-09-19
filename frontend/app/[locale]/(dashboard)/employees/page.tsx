"use client";

import { useQuery } from "@tanstack/react-query";

import { DataTable, type Column } from "@/components/tables/data-table";
import { api } from "@/lib/api";

interface Employee {
  id: number;
  code: string;
  fullName: string;
  department: string | null;
  active: boolean;
}

const COLUMNS: Column<Employee>[] = [
  { header: "Mã", cell: (row) => <span className="font-mono">{row.code}</span> },
  { header: "Họ tên", cell: (row) => row.fullName },
  { header: "Bộ phận", cell: (row) => row.department ?? "—" },
  {
    header: "Trạng thái",
    cell: (row) => (
      <span className={row.active ? "text-(--color-ok)" : "text-(--color-muted)"}>
        {row.active ? "đang làm" : "đã nghỉ"}
      </span>
    ),
  },
];

export default function EmployeesPage() {
  const employees = useQuery({
    queryKey: ["employees"],
    queryFn: async () =>
      (await api.get<{ rows: Employee[]; total: number }>("/employees")).data,
  });

  return (
    <section>
      <h1 className="text-lg font-semibold">Nhân viên</h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">
        {employees.data ? `${employees.data.total} người` : " "}
      </p>
      <DataTable
        columns={COLUMNS}
        rows={employees.data?.rows}
        keyOf={(row) => String(row.id)}
        pending={employees.isPending}
      />
    </section>
  );
}
