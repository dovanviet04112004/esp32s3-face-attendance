"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFeed } from "@/lib/ws";

interface Device {
  id: string;
  name: string | null;
  location: string | null;
  status: "PENDING" | "APPROVED" | "REVOKED";
  fwVersion: string | null;
  modelVersion: string | null;
  rosterVersion: number;
  lastSeenAt: string | null;
  online: boolean;
}

interface Release {
  releaseId: string;
  target: "FIRMWARE" | "MODELS" | "ASSETS";
  version: string;
  sizeBytes: number;
}

export default function DevicePage() {
  const t = useTranslations("devices");
  const common = useTranslations("common");
  const format = useFormatter();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const role = useSession((s) => s.role);
  const cache = useQueryClient();
  const { items } = useFeed();
  const [picked, setPicked] = useState("");
  const [offered, setOffered] = useState<string | null>(null);

  const device = useQuery({
    queryKey: ["devices", id],
    queryFn: async () => (await api.get<Device>(`/devices/${id}`)).data,
  });

  const releases = useQuery({
    queryKey: ["releases"],
    enabled: role === "ADMIN",
    queryFn: async () => (await api.get<Release[]>("/releases")).data,
  });

  const offer = useMutation({
    mutationFn: (releaseId: string) => api.post(`/releases/${releaseId}/offer/${id}`, {}),
    onSuccess: () => {
      setOffered(device.data?.name ?? id);
      void cache.invalidateQueries({ queryKey: ["devices", id] });
    },
  });

  const mine = useMemo(
    () => items.filter((item) => item.body.deviceId === id).slice(0, 12),
    [items, id],
  );

  if (device.isPending) {
    return <p className="text-sm text-(--color-muted)">{common("loading")}</p>;
  }
  if (!device.data) {
    return <p className="text-sm text-(--color-danger)">{common("failed")}</p>;
  }

  const it = device.data;
  const choices = releases.data ?? [];
  const chosen = choices.find((release) => release.releaseId === picked);
  const sameAlready = chosen?.target === "FIRMWARE" && chosen.version === it.fwVersion;

  const facts: [string, string][] = [
    [t("location"), it.location ?? common("empty")],
    [t("status"), it.status],
    [t("firmware"), it.fwVersion ?? common("empty")],
    [t("models"), it.modelVersion ?? common("empty")],
    [t("roster"), String(it.rosterVersion)],
    [
      t("lastSeen"),
      it.lastSeenAt ? format.dateTime(new Date(it.lastSeenAt), "medium") : t("never"),
    ],
  ];

  return (
    <section className="mx-auto w-full max-w-(--width-read)">
      <h1 className="text-lg font-semibold">{it.name ?? t("unnamed")}</h1>
      <p className="mt-1 font-mono text-xs text-(--color-muted)">{it.id}</p>
      <p className="mt-2 text-sm">
        <span className={it.online ? "text-(--color-ok)" : "text-(--color-muted)"}>
          {it.online ? t("online") : t("offline")}
        </span>
      </p>

      <dl className="mt-6 max-w-md divide-y divide-(--color-line) rounded-xl border border-(--color-line) bg-(--color-surface)">
        {facts.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 px-4 py-2.5 text-sm">
            <dt className="text-(--color-muted)">{label}</dt>
            <dd className="truncate font-mono text-xs">{value}</dd>
          </div>
        ))}
      </dl>

      {role === "ADMIN" ? (
        <div className="mt-8 max-w-md rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
          <h2 className="text-sm font-medium">{t("otaTitle")}</h2>
          <p className="mt-1 text-sm text-(--color-muted)">{t("otaLead")}</p>
          {choices.length === 0 ? (
            <p className="mt-4 text-sm text-(--color-muted)">{t("otaNone")}</p>
          ) : (
            <div className="mt-4 flex gap-2">
              <Select
                aria-label={t("otaVersion")}
                value={picked}
                onChange={(e) => setPicked(e.target.value)}
              >
                <option value="">{common("empty")}</option>
                {choices.map((release) => (
                  <option key={release.releaseId} value={release.releaseId}>
                    {release.target} {release.version}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                disabled={!picked || sameAlready || offer.isPending}
                onClick={() => offer.mutate(picked)}
                className="shrink-0"
              >
                {t("otaOffer")}
              </Button>
            </div>
          )}
          {sameAlready ? (
            <p className="mt-3 text-sm text-(--color-warn)">{t("otaSame")}</p>
          ) : null}
          {offered ? (
            <p className="mt-3 text-sm text-(--color-ok)">{t("otaSent", { device: offered })}</p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-8 max-w-md rounded-xl border border-(--color-line) bg-(--color-surface)">
        <h2 className="border-b border-(--color-line) px-4 py-3 text-sm font-medium">
          {t("eventsTitle")}
        </h2>
        {mine.length === 0 ? (
          <p className="px-4 py-6 text-sm text-(--color-muted)">{t("eventsEmpty")}</p>
        ) : (
          <ul className="divide-y divide-(--color-line)">
            {mine.map((item) => (
              <li key={item.id} className="truncate px-4 py-2 font-mono text-xs">
                {String(item.body.type ?? item.feed)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
