"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { DataTable, type Column } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
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
      id: "device",
      header: t("device"),
      sticky: true,
      sortBy: (row) => row.name ?? row.id,
      cell: (row) => (
        <Link href={`/devices/${row.id}`} className="block hover:underline">
          <p>{row.name ?? t("unnamed")}</p>
          <p className="font-mono text-xs text-(--color-muted)">{row.id}</p>
        </Link>
      ),
    },
    {
      id: "location",
      header: t("location"),
      sortBy: (row) => row.location ?? "",
      cell: (row) => row.location ?? common("empty"),
    },
    { id: "firmware", header: t("firmware"), cell: (row) => row.fwVersion ?? common("empty") },
    {
      id: "roster",
      header: t("roster"),
      numeric: true,
      sortBy: (row) => row.rosterVersion,
      cell: (row) => row.rosterVersion,
    },
    {
      id: "link",
      header: t("link"),
      sortBy: (row) => (row.online ? 1 : 0),
      cell: (row) => (
        <span className={row.online ? "text-(--color-ok)" : "text-(--color-muted)"}>
          {row.online ? t("online") : t("offline")}
        </span>
      ),
    },
    {
      id: "status",
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
        id="devices"
        columns={columns}
        rows={devices.data?.rows}
        keyOf={(row) => row.id}
        pending={devices.isPending}
        failed={devices.isError}
        onRetry={() => devices.refetch()}
      />
    </section>
  );
}
