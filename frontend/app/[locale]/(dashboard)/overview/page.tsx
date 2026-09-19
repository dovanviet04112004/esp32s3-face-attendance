"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { api } from "@/lib/api";

interface DevicePage {
  rows: { id: string; name: string | null; status: string; online: boolean }[];
  total: number;
}

export default function OverviewPage() {
  const t = useTranslations("overview");
  const common = useTranslations("common");
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: async () => (await api.get<DevicePage>("/devices")).data,
  });

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-(--color-muted)">
        {devices.isPending ? common("loading") : t("deviceCount", { count: devices.data?.total ?? 0 })}
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {devices.data?.rows.map((device) => (
          <article
            key={device.id}
            className="rounded-xl border border-(--color-line) bg-(--color-surface) p-4"
          >
            <p className="text-sm font-medium">{device.name ?? device.id}</p>
            <p className="mt-1 font-mono text-xs text-(--color-muted)">{device.id}</p>
            <p className="mt-3 text-xs">
              <span className={device.online ? "text-(--color-ok)" : "text-(--color-muted)"}>
                {device.online ? t("online") : t("offline")}
              </span>
              <span className="text-(--color-muted)"> · {device.status}</span>
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
