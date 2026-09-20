"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

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

export default function ShiftsPage() {
  const t = useTranslations("shifts");
  const shifts = useQuery({
    queryKey: ["shifts"],
    queryFn: async () => (await api.get<Shift[]>("/shifts")).data,
  });

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
  ];

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">{t("lead")}</p>
      <DataTable
        id="shifts"
        columns={columns}
        rows={shifts.data}
        keyOf={(row) => row.id}
        pending={shifts.isPending}
        failed={shifts.isError}
        onRetry={() => shifts.refetch()}
      />
    </section>
  );
}
