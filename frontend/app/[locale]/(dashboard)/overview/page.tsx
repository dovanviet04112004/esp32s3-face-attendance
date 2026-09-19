"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useFeed, type FeedItem } from "@/lib/ws";

interface DevicePage {
  rows: { id: string; name: string | null; status: string; online: boolean }[];
  total: number;
}

const DOT: Record<FeedItem["feed"], string> = {
  attendance: "bg-(--color-ok)",
  event: "bg-(--color-warn)",
  device: "bg-(--color-accent)",
};

const STATUS_TONE = {
  live: "text-(--color-ok)",
  reconnecting: "text-(--color-warn)",
  dropped: "text-(--color-danger)",
} as const;

function detail(item: FeedItem): string {
  const body = item.body;
  const parts = [body.deviceId, body.type, body.employeeId, body.severity, body.fwVersion];
  return parts.filter((part) => part !== undefined && part !== null).join(" · ");
}

export default function OverviewPage() {
  const t = useTranslations("overview");
  const common = useTranslations("common");
  const { status, items } = useFeed();
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: async () => (await api.get<DevicePage>("/devices")).data,
  });

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-(--color-muted)">
        {devices.isPending
          ? common("loading")
          : t("deviceCount", { count: devices.data?.total ?? 0 })}
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

      <div className="mt-8 rounded-xl border border-(--color-line) bg-(--color-surface)">
        <div className="flex items-baseline justify-between border-b border-(--color-line) px-4 py-3">
          <h2 className="text-sm font-medium">{t("feedTitle")}</h2>
          <span className={cn("text-xs", STATUS_TONE[status])}>{t(status)}</span>
        </div>
        {items.length === 0 ? (
          <p className="px-4 py-6 text-sm text-(--color-muted)">{t("feedEmpty")}</p>
        ) : (
          <ul className="divide-y divide-(--color-line)">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className={cn("size-2 shrink-0 rounded-full", DOT[item.feed])} />
                <span className="w-24 shrink-0 text-(--color-muted)">
                  {t(
                    item.feed === "attendance"
                      ? "feedAttendance"
                      : item.feed === "event"
                        ? "feedEvent"
                        : "feedDevice",
                  )}
                </span>
                <span className="truncate font-mono text-xs">{detail(item)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
