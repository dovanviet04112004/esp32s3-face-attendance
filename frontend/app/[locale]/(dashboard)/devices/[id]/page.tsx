"use client";

import { Banner, Button, Input, LayerCard, LayerDialog, Loader, SkeletonLine } from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  InfoIcon,
  PencilSimpleIcon,
  ProhibitIcon,
  PulseIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill, type Tone } from "@/components/ui/pill";
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

interface FleetUpdate {
  release: { releaseId: string; target: "FIRMWARE" | "MODELS"; version: string };
  behind: string[];
  updating: string[];
}

/** Read from the heartbeat and the kiosk's own OTA_FAILED event (KEHOACH 7.7). */
interface OfferStatus {
  releaseId: string;
  version: string;
  offeredAt: string;
  state: "WAITING" | "INSTALLED" | "FAILED" | "INTERRUPTED" | "EXPIRED";
  reason: string | null;
  busyUntil: string | null;
}

const STATUS_POLL_MS = 5_000;
const kTickMs = 1_000;
const kEventsShown = 12;

const STATUS_TONE: Record<Device["status"], Tone> = { PENDING: "waiting", APPROVED: "good", REVOKED: "idle" };

export default function DevicePage() {
  const t = useTranslations("devices");
  const common = useTranslations("common");
  const format = useFormatter();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const role = useSession((s) => s.role);
  const cache = useQueryClient();
  const notify = useNotify();
  const faultOf = useFault();
  const { items } = useFeed();
  const [editing, setEditing] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");

  const device = useQuery({
    queryKey: ["devices", id],
    queryFn: async () => (await api.get<Device>(`/devices/${id}`)).data,
    // A kiosk mid-update drops offline and returns on the new version; the page follows it.
    refetchInterval: () =>
      cache.getQueryData<OfferStatus | null>(["releases", "status", id])?.state === "WAITING" ? STATUS_POLL_MS : false,
  });

  const fleet = useQuery({
    queryKey: ["releases", "fleet"],
    enabled: role === "ADMIN",
    queryFn: async () => (await api.get<FleetUpdate[]>("/releases/fleet")).data,
  });

  const offerStatus = useQuery({
    queryKey: ["releases", "status", id],
    enabled: role === "ADMIN",
    queryFn: async () => (await api.get<OfferStatus | null>(`/releases/status/${id}`)).data,
    // Only a kiosk still fetching changes on its own; the others wait for the next press.
    refetchInterval: (query) => (query.state.data?.state === "WAITING" ? STATUS_POLL_MS : false),
  });

  const toldState = offerStatus.data?.state;
  const lastState = useRef(toldState);
  useEffect(() => {
    if (lastState.current === "WAITING" && toldState && toldState !== "WAITING") {
      void cache.invalidateQueries({ queryKey: ["devices", id] });
      void cache.invalidateQueries({ queryKey: ["releases", "fleet"] });
    }
    lastState.current = toldState;
  }, [toldState, cache, id]);
  const now = useNow({ updateInterval: toldState === "WAITING" ? kTickMs : undefined }).getTime();

  const offer = useMutation({
    mutationFn: async (update: FleetUpdate) => api.post(`/releases/${update.release.releaseId}/offer/${id}`, {}),
    onSuccess: (_, update) => {
      notify.done(t("offered", { version: update.release.version }));
      void cache.invalidateQueries({ queryKey: ["releases"] });
    },
    onError: notify.failed,
  });

  const rename = useMutation({
    mutationFn: () => api.patch(`/devices/${id}`, { name: name || undefined, location: location || undefined }),
    onSuccess: () => {
      setEditing(false);
      notify.done(t("renamed"));
      void cache.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const revoke = useMutation({
    mutationFn: () => api.post(`/devices/${id}/revoke`, {}),
    onSuccess: () => {
      setRevoking(false);
      notify.done(t("revoked"));
      void cache.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const resync = useMutation({
    mutationFn: async () => (await api.post<{ rosterVersion: number }>(`/enrollments/${id}/resync`, {})).data,
    onSuccess: (done) => {
      notify.done(t("resynced", { version: done.rosterVersion }));
      void cache.invalidateQueries({ queryKey: ["devices", id] });
    },
    onError: notify.failed,
  });

  const mine = useMemo(() => items.filter((item) => item.body.deviceId === id).slice(0, kEventsShown), [items, id]);

  if (device.isError) {
    return (
      <>
        <PageHeader title={t("detailTitle")} />
        <Failed onRetry={() => void device.refetch()} />
      </>
    );
  }

  const it = device.data;
  const title = it ? (it.name ?? t("unnamed")) : t("detailTitle");
  const newer = (fleet.data ?? []).filter((update) => update.behind.includes(id) || update.updating.includes(id));
  const told = offerStatus.data;
  const busy = told?.busyUntil ? Date.parse(told.busyUntil) > now : false;

  const toldText = told
    ? told.state === "FAILED"
      ? t("otaFailed", { version: told.version, reason: told.reason ?? common("empty") })
      : told.state === "INSTALLED"
        ? t("otaInstalled", { version: told.version })
        : told.state === "INTERRUPTED"
          ? t("otaInterrupted", { version: told.version })
          : told.state === "EXPIRED"
            ? t("otaExpired", { version: told.version })
            : busy
              ? t("otaBusy", {
                  version: told.version,
                  seconds: Math.max(0, Math.round((now - Date.parse(told.offeredAt)) / 1000)),
                })
              : t("otaStalled", { version: told.version, at: format.dateTime(new Date(told.offeredAt), "medium") })
    : null;
  const toldVariant = told?.state === "FAILED" ? "error" : told?.state === "INSTALLED" || busy ? "default" : "alert";
  const toldIcon =
    told?.state === "FAILED" ? (
      <WarningCircleIcon weight="fill" />
    ) : told?.state === "INSTALLED" ? (
      <CheckCircleIcon weight="fill" />
    ) : busy ? (
      <Loader size="sm" />
    ) : (
      <WarningIcon weight="fill" />
    );

  return (
    <>
      <PageHeader
        title={title}
        meta={
          it ? (
            <>
              <StatePill tone={STATUS_TONE[it.status]}>{t(`status${it.status}`)}</StatePill>
              {it.status === "APPROVED" ? (
                <StatePill tone={it.online ? "good" : "idle"}>{it.online ? t("online") : t("offline")}</StatePill>
              ) : null}
            </>
          ) : undefined
        }
        description={<span className="font-mono text-base">{id}</span>}
      />

      <PageLayout
        aside={
          <AsideCard title={t("factsTitle")}>
            {it ? (
              <Facts
                rows={[
                  [t("location"), it.location ?? common("empty")],
                  [t("status"), <StatePill key="s" tone={STATUS_TONE[it.status]}>{t(`status${it.status}`)}</StatePill>],
                  [t("firmware"), <span key="f" className="font-mono text-sm">{it.fwVersion ?? common("empty")}</span>],
                  [t("models"), <span key="m" className="font-mono text-sm">{it.modelVersion ?? common("empty")}</span>],
                  [t("roster"), <span key="r" className="tabular-nums">{it.rosterVersion}</span>],
                  [t("lastSeen"), it.lastSeenAt ? format.dateTime(new Date(it.lastSeenAt), "medium") : t("never")],
                ]}
              />
            ) : (
              <div className="flex flex-col gap-3">
                {Array.from({ length: 6 }, (_, at) => (
                  <SkeletonLine key={at} minWidth={120} maxWidth={300} />
                ))}
              </div>
            )}
          </AsideCard>
        }
        extra={
          role === "ADMIN" && it ? (
            <AsideCard title={t("careTitle")}>
              <div className="flex flex-col gap-2">
                <Button
                  variant="secondary"
                  icon={PencilSimpleIcon}
                  className="w-full justify-start"
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
                  variant="secondary"
                  icon={ArrowsClockwiseIcon}
                  className="w-full justify-start"
                  loading={resync.isPending}
                  onClick={() => resync.mutate()}
                >
                  {t("resync")}
                </Button>
                {it.status === "APPROVED" ? (
                  <Button
                    variant="secondary-destructive"
                    icon={ProhibitIcon}
                    className="w-full justify-start"
                    onClick={() => {
                      setFault(null);
                      setRevoking(true);
                    }}
                  >
                    {t("revoke")}
                  </Button>
                ) : null}
              </div>
            </AsideCard>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-6">
          {role === "ADMIN" ? (
            <LayerCard>
              <LayerCard.Secondary>{t("otaTitle")}</LayerCard.Secondary>
              <LayerCard.Primary className="flex flex-col gap-4">
                <p className="text-pretty text-kumo-subtle">{t("otaLead")}</p>
                {fleet.isPending ? (
                  <SkeletonLine minWidth={160} maxWidth={320} />
                ) : newer.length === 0 ? (
                  <p className="flex items-center gap-2">
                    <InfoIcon size={16} className="text-kumo-subtle" aria-hidden />
                    {(fleet.data ?? []).length === 0 ? t("otaNone") : t("otaCurrent")}
                  </p>
                ) : (
                  <ul className="-my-1 flex flex-col">
                    {newer.map((update) => (
                      <li
                        key={update.release.releaseId}
                        className="flex flex-wrap items-center justify-between gap-3 border-b border-kumo-hairline py-2 last:border-0"
                      >
                        <span>
                          {t("otaNewer", { target: t(`target${update.release.target}`), version: update.release.version })}
                        </span>
                        <Button
                          variant="secondary"
                          icon={ArrowsClockwiseIcon}
                          loading={offer.isPending && offer.variables?.release.releaseId === update.release.releaseId}
                          disabled={offer.isPending || busy || it?.status !== "APPROVED"}
                          onClick={() => offer.mutate(update)}
                        >
                          {busy
                            ? t("otaUpdating")
                            : told?.state === "WAITING" && told.releaseId === update.release.releaseId
                              ? t("otaRetry")
                              : t("otaUpdate")}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {told && toldText ? (
                  <Banner variant={toldVariant} icon={toldIcon} description={toldText} className="text-pretty" />
                ) : null}
              </LayerCard.Primary>
            </LayerCard>
          ) : null}

          <LayerCard>
            <LayerCard.Secondary>{t("eventsTitle")}</LayerCard.Secondary>
            <LayerCard.Primary>
              {mine.length === 0 ? (
                <p className="flex items-center gap-2 text-kumo-subtle">
                  <PulseIcon size={16} aria-hidden />
                  {t("eventsEmpty")}
                </p>
              ) : (
                <ul className="-my-1 flex flex-col">
                  {mine.map((item) => (
                    <li key={item.id} className="flex items-baseline gap-3 border-b border-kumo-hairline py-2 last:border-0">
                      <span className="w-11 shrink-0 text-sm text-kumo-subtle tabular-nums">
                        {typeof item.body.ts === "number" ? format.dateTime(new Date(item.body.ts), "clock") : ""}
                      </span>
                      <span className="min-w-0 truncate font-mono text-sm">{String(item.body.type ?? item.feed)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </LayerCard.Primary>
          </LayerCard>
        </div>
      </PageLayout>

      <LayerDialog.Root open={editing} onOpenChange={setEditing} dismissDisabled={rename.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("rename")}</LayerDialog.Title>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              <Input label={t("deviceName")} maxLength={64} value={name} onChange={(event) => setName(event.target.value)} />
              <Input
                label={t("location")}
                maxLength={64}
                value={location}
                onChange={(event) => setLocation(event.target.value)}
              />
              {fault ? <p className="text-kumo-danger">{fault}</p> : null}
            </div>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary loading={rename.isPending} onClick={() => rename.mutate()}>
              {common("save")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Alert open={revoking} onOpenChange={setRevoking} dismissDisabled={revoke.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("revokeTitle", { name: title })}</LayerDialog.Title>
          <LayerDialog.Description>{t("revokeWarn")}</LayerDialog.Description>
          <LayerDialog.Body>
            <p className="font-mono text-sm text-kumo-subtle">{[id, it?.location].filter(Boolean).join(" · ")}</p>
            {fault ? <p className="mt-3 text-kumo-danger">{fault}</p> : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary variant="destructive" loading={revoke.isPending} onClick={() => revoke.mutate()}>
              {t("revoke")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </>
  );
}
