"use client";

import { useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";

import { DataTable, type Column } from "@/components/tables/data-table";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";

interface Punch {
  id: string;
  deviceId: string;
  ts: string;
  direction: string;
  doorOpened: boolean;
  capturedOffline: boolean;
  clockUnsynced: boolean;
}

export default function MyAttendancePage() {
  const t = useTranslations("attendance");
  const me = useTranslations("me");
  const common = useTranslations("common");
  const format = useFormatter();
  const employeeId = useSession((s) => s.employeeId);

  const punches = useQuery({
    queryKey: ["attendance", "mine", employeeId],
    enabled: employeeId !== null,
    queryFn: async () =>
      (await api.get<{ rows: Punch[]; total: number }>(`/attendance?employeeId=${employeeId}`)).data,
  });

  const columns: Column<Punch>[] = [
    { header: t("at"), cell: (row) => format.dateTime(new Date(row.ts), "medium") },
    { header: t("direction"), cell: (row) => row.direction },
    {
      header: t("deviceCol"),
      cell: (row) => <span className="font-mono text-xs">{row.deviceId}</span>,
    },
    {
      header: t("flags"),
      cell: (row) =>
        row.clockUnsynced ? (
          <span className="text-(--color-warn)">{t("flagClock")}</span>
        ) : (
          <span className="text-(--color-muted)">{common("empty")}</span>
        ),
    },
  ];

  if (employeeId === null) {
    return <p className="text-sm text-(--color-muted)">{me("noProfile")}</p>;
  }

  return (
    <section>
      <h1 className="text-lg font-semibold">{me("thisMonth")}</h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">{t("lead")}</p>
      <DataTable
        columns={columns}
        rows={punches.data?.rows}
        keyOf={(row) => row.id}
        pending={punches.isPending}
        empty={t("historyEmpty")}
      />
    </section>
  );
}
