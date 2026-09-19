"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { DataTable, type Column } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";

interface Device {
  id: string;
  name: string | null;
  location: string | null;
  status: "PENDING" | "APPROVED" | "REVOKED";
  fwVersion: string | null;
  rosterVersion: number;
  online: boolean;
}

export default function DevicesPage() {
  const t = useTranslations("devices");
  const common = useTranslations("common");
  const role = useSession((s) => s.role);
  const cache = useQueryClient();
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: async () => (await api.get<{ rows: Device[]; total: number }>("/devices")).data,
  });
  const approve = useMutation({
    mutationFn: (id: string) => api.post(`/devices/${id}/approve`, {}),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["devices"] }),
  });

  const columns: Column<Device>[] = [
    {
      header: t("device"),
      cell: (row) => (
        <div>
          <p>{row.name ?? t("unnamed")}</p>
          <p className="font-mono text-xs text-(--color-muted)">{row.id}</p>
        </div>
      ),
    },
    { header: t("location"), cell: (row) => row.location ?? common("empty") },
    { header: t("firmware"), cell: (row) => row.fwVersion ?? common("empty") },
    { header: t("roster"), cell: (row) => row.rosterVersion, numeric: true },
    {
      header: t("link"),
      cell: (row) => (
        <span className={row.online ? "text-(--color-ok)" : "text-(--color-muted)"}>
          {row.online ? t("online") : t("offline")}
        </span>
      ),
    },
    {
      header: t("status"),
      cell: (row) =>
        row.status === "PENDING" && role === "ADMIN" ? (
          <Button
            size="sm"
            tone="quiet"
            disabled={approve.isPending}
            onClick={() => approve.mutate(row.id)}
          >
            {approve.isPending ? t("approving") : t("approve")}
          </Button>
        ) : (
          <span className="text-(--color-muted)">{row.status}</span>
        ),
    },
  ];

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">{t("lead")}</p>
      <DataTable
        columns={columns}
        rows={devices.data?.rows}
        keyOf={(row) => row.id}
        pending={devices.isPending}
      />
    </section>
  );
}
