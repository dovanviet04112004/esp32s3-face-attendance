"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";

import { Failed } from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
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
  const [editing, setEditing] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const faultOf = useFault();

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

  const rename = useMutation({
    mutationFn: () =>
      api.patch(`/devices/${id}`, {
        name: name || undefined,
        location: location || undefined,
      }),
    onSuccess: () => {
      setEditing(false);
      void cache.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const revoke = useMutation({
    mutationFn: () => api.post(`/devices/${id}/revoke`, {}),
    onSuccess: () => {
      setRevoking(false);
      void cache.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const resync = useMutation({
    mutationFn: async () =>
      (await api.post<{ rosterVersion: number }>(`/enrollments/${id}/resync`, {})).data,
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["devices", id] }),
    onError: (fell: unknown) => setFault(faultOf(fell)),
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

  if (device.isError) {
    return <Failed onRetry={() => void device.refetch()} />;
  }

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

      {role === "ADMIN" ? (
        <div className="mt-4 max-w-md rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
          <h2 className="text-sm font-medium">{t("careTitle")}</h2>
          <p className="mt-1 text-sm text-(--color-muted)">{t("careLead")}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              tone="quiet"
              onClick={() => {
                setFault(null);
                setName(it.name ?? "");
                setLocation(it.location ?? "");
                setEditing(true);
              }}
            >
              {t("rename")}
            </Button>
            <Button
              type="button"
              tone="quiet"
              disabled={resync.isPending}
              onClick={() => {
                setFault(null);
                resync.mutate();
              }}
            >
              {resync.isPending ? common("saving") : t("resync")}
            </Button>
            {it.status === "APPROVED" ? (
              <Button
                type="button"
                tone="danger"
                onClick={() => {
                  setFault(null);
                  setRevoking(true);
                }}
              >
                {t("revoke")}
              </Button>
            ) : null}
          </div>
          {resync.data ? (
            <p className="mt-3 text-sm text-(--color-ok)">
              {t("resynced", { version: resync.data.rosterVersion })}
            </p>
          ) : null}
          {fault ? (
            <p role="alert" className="mt-3 text-sm text-(--color-danger)">
              {fault}
            </p>
          ) : null}
        </div>
      ) : null}

      <Sheet
        open={editing}
        onClose={() => setEditing(false)}
        title={t("rename")}
        closeLabel={common("close")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setFault(null);
            rename.mutate();
          }}
        >
          <label className="block text-sm font-medium" htmlFor="deviceName">
            {t("deviceName")}
          </label>
          <Input
            id="deviceName"
            maxLength={64}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-1"
          />

          <label className="mt-4 block text-sm font-medium" htmlFor="deviceLocation">
            {t("location")}
          </label>
          <Input
            id="deviceLocation"
            maxLength={64}
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            className="mt-1"
          />

          <Button type="submit" disabled={rename.isPending} className="mt-4">
            {rename.isPending ? common("saving") : common("save")}
          </Button>
        </form>
      </Sheet>

      <Sheet
        open={revoking}
        onClose={() => setRevoking(false)}
        title={t("revoke")}
        closeLabel={common("close")}
      >
        <p className="text-sm text-(--color-muted)">{t("revokeWarn")}</p>
        <Button
          type="button"
          tone="danger"
          className="mt-4"
          disabled={revoke.isPending}
          onClick={() => revoke.mutate()}
        >
          {revoke.isPending ? common("saving") : t("revoke")}
        </Button>
      </Sheet>

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
