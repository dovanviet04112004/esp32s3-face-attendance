"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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
      header: "Thiết bị",
      cell: (row) => (
        <div>
          <p>{row.name ?? "chưa đặt tên"}</p>
          <p className="font-mono text-xs text-(--color-muted)">{row.id}</p>
        </div>
      ),
    },
    { header: "Vị trí", cell: (row) => row.location ?? "—" },
    { header: "Firmware", cell: (row) => row.fwVersion ?? "—" },
    { header: "Danh sách", cell: (row) => row.rosterVersion, numeric: true },
    {
      header: "Kết nối",
      cell: (row) => (
        <span className={row.online ? "text-(--color-ok)" : "text-(--color-muted)"}>
          {row.online ? "đang kết nối" : "ngoại tuyến"}
        </span>
      ),
    },
    {
      header: "Trạng thái",
      cell: (row) =>
        row.status === "PENDING" && role === "ADMIN" ? (
          <Button size="sm" tone="quiet" onClick={() => approve.mutate(row.id)}>
            Duyệt máy
          </Button>
        ) : (
          <span className="text-(--color-muted)">{row.status}</span>
        ),
    },
  ];

  return (
    <section>
      <h1 className="text-lg font-semibold">Thiết bị</h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">
        Máy chưa ai nhận nằm ở PENDING cho tới khi một người đối chiếu mã trên màn hình
      </p>
      <DataTable
        columns={columns}
        rows={devices.data?.rows}
        keyOf={(row) => row.id}
        pending={devices.isPending}
      />
    </section>
  );
}
