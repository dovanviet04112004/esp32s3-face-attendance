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
    { header: t("name"), cell: (row) => row.name },
    { header: t("startTime"), cell: (row) => row.startTime, numeric: true },
    { header: t("endTime"), cell: (row) => row.endTime, numeric: true },
    { header: t("graceMinutes"), cell: (row) => row.graceMinutes, numeric: true },
    {
      header: t("status"),
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
        columns={columns}
        rows={shifts.data}
        keyOf={(row) => row.id}
        pending={shifts.isPending}
      />
    </section>
  );
}
