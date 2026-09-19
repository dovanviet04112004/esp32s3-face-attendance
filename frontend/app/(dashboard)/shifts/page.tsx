"use client";

import { useQuery } from "@tanstack/react-query";

import { DataTable, type Column } from "@/components/tables/data-table";
import { api } from "@/lib/api";

interface Shift {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  graceMinutes: number;
  active: boolean;
}

const COLUMNS: Column<Shift>[] = [
  { header: "Ca", cell: (row) => row.name },
  { header: "Bắt đầu", cell: (row) => row.startTime, numeric: true },
  { header: "Kết thúc", cell: (row) => row.endTime, numeric: true },
  { header: "Dung sai (phút)", cell: (row) => row.graceMinutes, numeric: true },
  {
    header: "Trạng thái",
    cell: (row) => (
      <span className={row.active ? "text-(--color-ok)" : "text-(--color-muted)"}>
        {row.active ? "đang dùng" : "đã ngưng"}
      </span>
    ),
  },
];

export default function ShiftsPage() {
  const shifts = useQuery({
    queryKey: ["shifts"],
    queryFn: async () => (await api.get<Shift[]>("/shifts")).data,
  });

  return (
    <section>
      <h1 className="text-lg font-semibold">Ca làm</h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">
        Ca đã ngưng vẫn đọc được, vì phân công cũ còn trỏ vào nó
      </p>
      <DataTable
        columns={COLUMNS}
        rows={shifts.data}
        keyOf={(row) => row.id}
        pending={shifts.isPending}
      />
    </section>
  );
}
