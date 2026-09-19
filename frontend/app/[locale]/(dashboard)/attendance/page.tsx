"use client";

import { useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";

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

export default function AttendancePage() {
  const t = useTranslations("attendance");
  const common = useTranslations("common");
  const format = useFormatter();
  const year = new Date().getFullYear();
  const from = new Date(Date.UTC(year, 0, 1)).toISOString();
  const to = new Date(Date.UTC(year + 1, 0, 1)).toISOString();
  const rollup = useQuery({
    queryKey: ["attendance", from, to],
    queryFn: async () =>
      (await api.get<Tally[]>(`/reports/attendance?from=${from}&to=${to}`)).data,
  });

  function clock(iso: string | null) {
    return iso ? format.dateTime(new Date(iso), "medium") : common("empty");
  }

  const columns: Column<Tally>[] = [
    { header: t("employee"), cell: (row) => row.fullName },
    { header: t("punches"), cell: (row) => row.punches, numeric: true },
    { header: t("firstAt"), cell: (row) => clock(row.firstAt) },
    { header: t("lastAt"), cell: (row) => clock(row.lastAt) },
    {
      header: t("unsyncedClock"),
      numeric: true,
      cell: (row) =>
        row.unsyncedClock > 0 ? (
          <span className="text-(--color-danger)">{row.unsyncedClock}</span>
        ) : (
          <span className="text-(--color-muted)">0</span>
        ),
    },
  ];

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">{t("lead")}</p>
      <DataTable
        columns={columns}
        rows={rollup.data}
        keyOf={(row) => String(row.employeeId)}
        pending={rollup.isPending}
        empty={t("rangeEmpty")}
      />
    </section>
  );
}
