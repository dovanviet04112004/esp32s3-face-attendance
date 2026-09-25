"use client";

import { Banner, Button, Input, LayerCard, LayerDialog, Loader } from "@cloudflare/kumo";
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
import { useOptional } from "@/components/ui/optional";
import { AsideCard, Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill, type Tone } from "@/components/ui/pill";
import { SkeletonLine } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { clockDrifts, stampOptions } from "@/lib/format";
import { useFeed, type FeedItem } from "@/lib/ws";

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
  clockSkewMs?: number | null;
}

interface FleetUpdate {
  release: { releaseId: string; target: "FIRMWARE" | "MODELS"; version: string };
  behind: string[];
  updating: string[];
  offline: string[];
  /** Kiosks this release moves to another recognition model; the server takes it for them only fleet-wide. */
  recapture: string[];
}

/** Read from the heartbeat and the kiosk's own OTA_ROLLED_BACK and OTA_FAILED events (KEHOACH 7.7). */
interface OfferStatus {
  releaseId: string;
  version: string;
  offeredAt: string;
  state: "WAITING" | "INSTALLED" | "TRIAL" | "ROLLED_BACK" | "FAILED" | "INTERRUPTED" | "EXPIRED";
  reason: string | null;
  busyUntil: string | null;
}

const STATUS_POLL_MS = 5_000;
// The states the kiosk still moves out of on its own; the page follows them until they end.
const MOVING: ReadonlySet<OfferStatus["state"] | undefined> = new Set(["WAITING", "TRIAL"]);
const kInSyncMs = 1_000;
// Where a skew reads better in the next unit up, largest first.
const SKEW_UNITS: [unit: "day" | "hour" | "minute" | "second", ms: number, from: number][] = [
  ["day", 86_400_000, 172_800_000],
  ["hour", 3_600_000, 5_400_000],
  ["minute", 60_000, 90_000],
  ["second", 1_000, 0],
];
const kTickMs = 1_000;
const kEventsShown = 12;

const STATUS_TONE: Record<Device["status"], Tone> = { PENDING: "waiting", APPROVED: "good", REVOKED: "idle" };
const kNameMax = 64;
const EVENTS = [
  "SPOOF_DETECTED",
  "UNKNOWN_FACE",
  "QUALITY_REJECTED",
  "DOOR_OPENED_MANUALLY",
  "DOOR_FAULT",
  "CAMERA_FAULT",
  "TOF_FAULT",
  "LCD_FAULT",
  "AUDIO_FAULT",
  "STORAGE_FAULT",
  "FACEDB_CORRUPT",
  "MODEL_LOAD_FAILED",
  "OTA_FAILED",
  "OTA_ROLLED_BACK",
  "TIME_UNSYNCED",
  "BOOTED",
  "COMMAND_DONE",
  "COMMAND_REJECTED",
  "ROSTER_REJECTED",
] as const;

function isEvent(raw: unknown): raw is (typeof EVENTS)[number] {
  return typeof raw === "string" && (EVENTS as readonly string[]).includes(raw);
}

export default function DevicePage() {
  const t = useTranslations("devices");
  const a = useTranslations("attendance");
  const common = useTranslations("common");
  const format = useFormatter();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const role = useSession((s) => s.role);
  const cache = useQueryClient();
  const notify = useNotify();
  const faultOf = useFault();
  const optional = useOptional();
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
      MOVING.has(cache.getQueryData<OfferStatus | null>(["releases", "status", id])?.state) ? STATUS_POLL_MS : false,
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
    refetchInterval: (query) => (MOVING.has(query.state.data?.state) ? STATUS_POLL_MS : false),
  });

  const toldState = offerStatus.data?.state;
  const lastState = useRef(toldState);
  useEffect(() => {
    if (MOVING.has(lastState.current) && toldState && toldState !== lastState.current) {
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
      void cache.invalidateQueries({ queryKey: ["releases"] });
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
  const feedAt = (item: FeedItem) => new Date(typeof item.body.ts === "number" ? item.body.ts : item.heardAt);

  function skewText(skewMs: number | null | undefined): string {
    if (typeof skewMs !== "number") {
      return common("empty");
    }
    const size = Math.abs(skewMs);
    if (size < kInSyncMs) {
      return t("clockInSync");
    }
    const [unit, unitMs] = SKEW_UNITS.find(([, , from]) => size >= from) ?? ["second", kInSyncMs];
    const amount = format.number(size / unitMs, { style: "unit", unit, unitDisplay: "long", maximumFractionDigits: 1 });
    return skewMs > 0 ? t("clockAhead", { amount }) : t("clockBehind", { amount });
  }

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
  const newer = (fleet.data ?? []).filter(
    (update) => update.behind.includes(id) || update.updating.includes(id) || update.offline.includes(id),
  );
  const told = offerStatus.data;
  const busy = told?.busyUntil ? Date.parse(told.busyUntil) > now : false;

  const broke = told?.state === "FAILED" || told?.state === "ROLLED_BACK";
  const going = busy || told?.state === "TRIAL";
  const sentenceOf = (offer: OfferStatus): string => {
    const version = offer.version;
    switch (offer.state) {
      case "FAILED":
        return t("otaFailed", { version, reason: offer.reason ?? common("empty") });
      case "ROLLED_BACK":
        return t("otaRolledBack", { version });
      case "INSTALLED":
        return t("otaInstalled", { version });
      case "TRIAL":
        return t("otaTrial", { version });
      case "INTERRUPTED":
        return t("otaInterrupted", { version });
      case "EXPIRED":
        return t("otaExpired", { version });
      case "WAITING":
        return busy
          ? t("otaBusy", { version, seconds: Math.max(0, Math.round((now - Date.parse(offer.offeredAt)) / 1000)) })
          : t("otaStalled", { version, at: format.dateTime(new Date(offer.offeredAt), "medium") });
    }
  };
  const toldText = told ? sentenceOf(told) : null;
  const toldVariant = broke ? "error" : told?.state === "INSTALLED" || going ? "default" : "alert";
  const toldIcon = broke ? (
    <WarningCircleIcon weight="fill" />
  ) : told?.state === "INSTALLED" ? (
    <CheckCircleIcon weight="fill" />
  ) : going ? (
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
                  [
                    t("clockSkew"),
                    <span key="k" className="flex flex-wrap items-center justify-end gap-1.5">
                      <span>{skewText(it.clockSkewMs)}</span>
                      {clockDrifts(it.clockSkewMs) ? <StatePill tone="waiting">{t("clockDrift")}</StatePill> : null}
                    </span>,
                  ],
                ]}
              />
            ) : (
              <div className="flex flex-col gap-3">
                {Array.from({ length: 7 }, (_, at) => (
                  <SkeletonLine key={at} minWidth={25} maxWidth={50} />
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
                  <SkeletonLine minWidth={27} maxWidth={53} />
                ) : newer.length === 0 ? (
                  <p className="flex items-center gap-2">
                    <InfoIcon size={16} className="text-kumo-subtle" aria-hidden />
                    {(fleet.data ?? []).length === 0 ? t("otaNone") : t("otaCurrent")}
                  </p>
                ) : (
                  <ul className="-my-1 flex flex-col">
                    {newer.map((update) => {
                      const fleetOnly = update.recapture.includes(id);
                      const hintId = `ota-hint-${update.release.releaseId}`;
                      return (
                        <li
                          key={update.release.releaseId}
                          className="flex flex-wrap items-center justify-between gap-3 border-b border-kumo-hairline py-2 last:border-0"
                        >
                          <span className="flex min-w-0 grow basis-60 flex-col gap-1">
                            <span>
                              {t("otaNewer", { target: t(`target${update.release.target}`), version: update.release.version })}
                            </span>
                            {fleetOnly ? (
                              <span id={hintId} className="text-sm text-pretty text-kumo-subtle">
                                {t("otaRecaptureHint")}
                              </span>
                            ) : null}
                          </span>
                          <Button
                            variant="secondary"
                            icon={ArrowsClockwiseIcon}
                            loading={offer.isPending && offer.variables?.release.releaseId === update.release.releaseId}
                            disabled={offer.isPending || busy || fleetOnly || it?.status !== "APPROVED" || !it?.online}
                            aria-describedby={fleetOnly ? hintId : undefined}
                            onClick={() => offer.mutate(update)}
                          >
                            {busy
                              ? t("otaUpdating")
                              : !it?.online
                                ? t("otaOffline")
                                : told?.state === "WAITING" && told.releaseId === update.release.releaseId
                                  ? t("otaRetry")
                                  : t("otaUpdate")}
                          </Button>
                        </li>
                      );
                    })}
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
                      <span className="min-w-11 shrink-0 text-sm whitespace-nowrap text-kumo-subtle tabular-nums">
                        {format.dateTime(feedAt(item), stampOptions(feedAt(item)))}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {isEvent(item.body.type)
                          ? t(`event_${item.body.type}`)
                          : item.feed === "attendance"
                            ? t("feedAttendance")
                            : typeof item.body.online === "boolean"
                              ? item.body.online
                                ? t("online")
                                : t("offline")
                              : t(`status${item.body.status as Device["status"]}`)}
                      </span>
                      {item.feed === "attendance" && item.body.questionableTime === true ? (
                        <StatePill tone="bad">{a("flagQuestionable")}</StatePill>
                      ) : item.feed === "attendance" && item.body.clockUnsynced === true ? (
                        <StatePill tone="waiting">{a("flagClock")}</StatePill>
                      ) : null}
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
              <Input label={optional(t("deviceName"))} maxLength={kNameMax} value={name} onChange={(event) => setName(event.target.value)} />
              <Input
                label={optional(t("location"))}
                maxLength={kNameMax}
                value={location}
                onChange={(event) => setLocation(event.target.value)}
              />
              {fault ? <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null}
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
            <div className="flex flex-col gap-3">
              <p className="font-mono text-sm text-kumo-subtle">{[id, it?.location].filter(Boolean).join(" · ")}</p>
              {fault ? <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null}
            </div>
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
