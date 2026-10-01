"use client";

import { Button, Empty } from "@cloudflare/kumo";
import { DeviceMobileIcon, TrashIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";

import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { StatePill } from "@/components/ui/pill";
import { SkeletonLine } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { PUSH_DEVICES_KEY, pushHere } from "./push-switch";

interface Device {
  id: string;
  endpoint: string;
  userAgent: string | null;
  createdAt: string;
  lastSentAt: string | null;
}

const BROWSERS: [RegExp, string][] = [
  [/Edg\//, "Edge"],
  [/OPR\//, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Chrome\//, "Chrome"],
  [/Firefox\//, "Firefox"],
  [/Safari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/Android/, "Android"],
  [/iPhone|iPad/, "iOS"],
  [/Windows/, "Windows"],
  [/Mac OS X/, "macOS"],
  [/Linux/, "Linux"],
];

function nameOf(agent: string | null): string | null {
  if (!agent) {
    return null;
  }
  const browser = BROWSERS.find(([match]) => match.test(agent))?.[1];
  const system = SYSTEMS.find(([match]) => match.test(agent))?.[1];
  return [browser, system].filter(Boolean).join(" · ") || null;
}

/** Every device this account receives push on, each other device removable on its own (KEHOACH 9.21.4). */
export function PushDevices() {
  const t = useTranslations("notices");
  const format = useFormatter();
  const cache = useQueryClient();
  const notify = useNotify();

  const devices = useQuery({
    queryKey: PUSH_DEVICES_KEY,
    queryFn: async () => (await api.get<Device[]>("/notifications/subscriptions")).data,
  });

  // The switch above reads this browser's own subscription, so this browser's row offers no removal.
  const here = useQuery({
    queryKey: [...PUSH_DEVICES_KEY, "here"],
    queryFn: async () => (await pushHere())?.endpoint ?? null,
  });

  const drop = useMutation({
    mutationFn: (device: Device) => api.delete(`/notifications/subscriptions/${device.id}`),
    onSuccess: () => {
      notify.done(t("deviceRemoved"));
      void cache.invalidateQueries({ queryKey: PUSH_DEVICES_KEY });
    },
    onError: notify.failed,
  });

  if (devices.isError) {
    return <Failed onRetry={() => void devices.refetch()} />;
  }
  if (devices.isPending) {
    return (
      <div aria-hidden className="flex w-full flex-col gap-3 py-2">
        <SkeletonLine minWidth={45} maxWidth={45} />
        <SkeletonLine minWidth={30} maxWidth={30} />
      </div>
    );
  }
  if (devices.data.length === 0) {
    return <Empty size="sm" icon={<DeviceMobileIcon size={32} className="text-kumo-inactive" />} title={t("devicesEmpty")} />;
  }
  return (
    <ul className="flex w-full flex-col">
      {devices.data.map((device) => (
        <li key={device.id} className="flex min-h-12 items-center gap-3 border-t border-kumo-hairline py-2 first:border-0">
          <DeviceMobileIcon size={18} className="shrink-0 text-kumo-subtle" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex flex-wrap items-center gap-2">
              <span className="truncate">{nameOf(device.userAgent) ?? t("deviceUnknown")}</span>
              {device.endpoint === here.data ? <StatePill tone="good">{t("deviceThis")}</StatePill> : null}
            </span>
            <span className="text-sm text-kumo-subtle tabular-nums">
              {device.lastSentAt
                ? t("deviceLastSent", { time: format.dateTime(new Date(device.lastSentAt), "medium") })
                : t("deviceSince", { time: format.dateTime(new Date(device.createdAt), "medium") })}
            </span>
          </span>
          {device.endpoint === here.data ? null : (
            <Button
              variant="ghost"
              shape="square"
              icon={TrashIcon}
              aria-label={t("deviceRemove")}
              loading={drop.isPending && drop.variables?.id === device.id}
              onClick={() => drop.mutate(device)}
            />
          )}
        </li>
      ))}
    </ul>
  );
}
