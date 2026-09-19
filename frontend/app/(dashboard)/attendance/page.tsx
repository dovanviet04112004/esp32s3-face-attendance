"use client";

import { useQuery } from "@tanstack/react-query";

import { DataTable, type Column } from "@/components/tables/data-table";
import { api } from "@/lib/api";

interface Tally {
  employeeId: number;
  fullName: string;
  punches: number;
  firstAt: string | null;
  lastAt: string | null;
  unsyncedClock: number;
}

function clock(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("vi-VN") : "—";
}

const COLUMNS: Column<Tally>[] = [
  { header: "Nhân viên", cell: (row) => row.fullName },
  { header: "Lượt", cell: (row) => row.punches, numeric: true },
  { header: "Lần đầu", cell: (row) => clock(row.firstAt) },
  { header: "Lần cuối", cell: (row) => clock(row.lastAt) },
  {
    header: "Giờ không tin được",
    numeric: true,
    cell: (row) =>
      row.unsyncedClock > 0 ? (
        <span className="text-(--color-danger)">{row.unsyncedClock}</span>
      ) : (
        <span className="text-(--color-muted)">0</span>
      ),
  },
];

export default function AttendancePage() {
  const year = new Date().getFullYear();
  const from = new Date(Date.UTC(year, 0, 1)).toISOString();
  const to = new Date(Date.UTC(year + 1, 0, 1)).toISOString();
  const rollup = useQuery({
    queryKey: ["attendance", from, to],
    queryFn: async () =>
      (await api.get<Tally[]>(`/reports/attendance?from=${from}&to=${to}`)).data,
  });

  return (
    <section>
      <h1 className="text-lg font-semibold">Chấm công</h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">
        Năm {year}. Cột cuối đếm bản ghi mà kiosk tự khai là giờ chưa đồng bộ NTP
      </p>
      <DataTable
        columns={COLUMNS}
        rows={rollup.data}
        keyOf={(row) => String(row.employeeId)}
        pending={rollup.isPending}
        empty="Chưa có lượt chấm công nào trong năm"
      />
    </section>
  );
}
