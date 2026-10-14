"use client";

import { Banner, Button, Input, LayerDialog } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, ArrowsClockwiseIcon, CheckCircleIcon, WarningCircleIcon, WarningIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { Suspense, useEffect, useState } from "react";

import {
  headlineOf,
  ReleaseNotesDialog,
  ReleaseNotesParts,
  ReleaseSummary,
  useNotesOf,
  type ReleaseNotesFacts,
} from "@/components/devices/release-notes";
import { DataTable, type Column, type RowAction } from "@/components/tables/data-table";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill, type Tone } from "@/components/ui/pill";
import { SkeletonLine } from "@/components/ui/skeleton";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { clockDrifts, stampOptions } from "@/lib/format";
import { useUrlState } from "@/lib/url-state";
import { isDeviceEvent, useFeed, type FeedItem, type FeedStatus } from "@/lib/ws";

interface Release {
  releaseId: string;
  target: "FIRMWARE" | "MODELS";
  version: string;
  createdAt: string;
  available: boolean;
  notesVi: string | null;
  notesEn: string | null;
}

/** The newest release of one kind and the approved kiosks behind it; the server owns the rule. */
interface FleetUpdate {
  release: Release;
  behind: string[];
  updating: string[];
  offline: string[];
  changesRecognition: boolean;
}

interface Device {
  id: string;
  name: string | null;
  location: string | null;
  status: "PENDING" | "APPROVED" | "REVOKED";
  fwVersion: string | null;
  rosterVersion: number;
  lastSeenAt: string | null;
  online: boolean;
  clockSkewMs?: number | null;
}

interface DevicePage {
  rows: Device[];
  total: number;
  totalIsExact?: boolean;
}

type Counts = Record<"PENDING" | "APPROVED" | "REVOKED" | "online" | "offline", number>;

interface Person {
  id: number;
  code: string;
  fullName: string;
}

const SHOWS = ["", "online", "offline", "PENDING", "APPROVED", "REVOKED"] as const;
type Show = (typeof SHOWS)[number];

const STATUS_TONE: Record<Device["status"], Tone> = { PENDING: "waiting", APPROVED: "good", REVOKED: "idle" };
const LINK_TONE: Record<FeedStatus, Tone> = { live: "good", reconnecting: "waiting", dropped: "bad" };
const FEED_KEY: Record<FeedItem["feed"], "feedAttendance" | "feedEvent" | "feedDevice"> = {
  attendance: "feedAttendance",
  event: "feedEvent",
  device: "feedDevice",
};

const FLEET_POLL_MS = 5_000;
const kPage = 50;
const kHistoryShown = 6;
const kClaimDigits = 6;
const kFeedRows = 12;
const kTickMs = 60_000;

function showOf(raw: string): Show {
  return (SHOWS as readonly string[]).includes(raw) ? (raw as Show) : "";
}

function Devices() {
  const t = useTranslations("devices");
  const a = useTranslations("attendance");
  const common = useTranslations("common");
  const format = useFormatter();
  const now = useNow({ updateInterval: kTickMs });
  const cache = useQueryClient();
  const router = useRouter();
  const notify = useNotify();
  const faultOf = useFault();
  const isAdmin = useSession((s) => s.role) === "ADMIN";
  const { status: link, items } = useFeed();

  const [url, setUrl] = useUrlState({ q: "", show: "" });
  const [typed, setTyped] = useState(url.q);
  const settled = useSettled(typed.trim());
  useEffect(() => {
    if (settled !== url.q) {
      setUrl({ q: settled });
    }
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps
  const show = showOf(url.show);

  const [asking, setAsking] = useState(false);
  const [approving, setApproving] = useState<Device | null>(null);
  const [claim, setClaim] = useState("");
  const [fault, setFault] = useState<string | null>(null);
  const [wholeHistory, setWholeHistory] = useState(false);
  const [reading, setReading] = useState<ReleaseNotesFacts[] | null>(null);
  const notesOf = useNotesOf();

  const filter = new URLSearchParams();
  if (url.q) {
    filter.set("search", url.q);
  }
  if (show === "online" || show === "offline") {
    filter.set("online", String(show === "online"));
  } else if (show) {
    filter.set("status", show);
  }

  // While any kiosk installs, both lists follow it until it returns on the new version.
  const installing = (): number | false =>
    (cache.getQueryData<FleetUpdate[]>(["releases", "fleet"]) ?? []).some((one) => one.updating.length > 0)
      ? FLEET_POLL_MS
      : false;
  const devices = useInfiniteQuery({
    queryKey: ["devices", "list", filter.toString()],
    enabled: isAdmin,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const page = new URLSearchParams(filter);
      page.set("take", String(kPage));
      page.set("skip", String(pageParam));
      return (await api.get<DevicePage>(`/devices?${page.toString()}`)).data;
    },
    getNextPageParam: (last, pages) => {
      const shown = pages.reduce((sum, one) => sum + one.rows.length, 0);
      return shown < last.total ? shown : undefined;
    },
    refetchInterval: installing,
  });
  const counts = useQuery({
    queryKey: ["devices", "counts"],
    enabled: isAdmin,
    queryFn: async () => (await api.get<Counts>("/devices/counts")).data,
  });
  const releases = useQuery({
    queryKey: ["releases"],
    enabled: isAdmin,
    queryFn: async () => (await api.get<Release[]>("/releases")).data,
  });
  const fleet = useQuery({
    queryKey: ["releases", "fleet"],
    enabled: isAdmin,
    queryFn: async () => (await api.get<FleetUpdate[]>("/releases/fleet")).data,
    refetchInterval: installing,
  });
  // One update per kiosk, whichever of firmware and models it lacks; the server orders the steps (KEHOACH 7.7).
  const updates = fleet.data ?? [];
  const newestParts = updates.map((update) => update.release);
  const kiosksIn = (pick: (update: FleetUpdate) => string[]) => [...new Set(updates.flatMap(pick))];
  const updating = kiosksIn((update) => update.updating);
  const behind = kiosksIn((update) => update.behind).filter((id) => !updating.includes(id));
  const offline = kiosksIn((update) => update.offline).filter((id) => !updating.includes(id) && !behind.includes(id));
  const movesRecognition = updates.some((update) => update.changesRecognition);
  const partsText = newestParts.map((one) => `${t(`target${one.target}`)} ${one.version}`).join(" · ");

  const recent = items.slice(0, kFeedRows);
  const punchers = [...new Set(recent.map((item) => item.body.employeeId).filter((id): id is number => typeof id === "number"))];
  // A name reads where an id does not; each lookup is cached with the rest of the app's employee reads.
  const people = useQueries({
    queries: punchers.map((id) => ({
      queryKey: ["employees", id],
      enabled: isAdmin,
      staleTime: Infinity,
      retry: false,
      queryFn: async () => (await api.get<Person>(`/employees/${id}`)).data,
    })),
  });
  const personOf = (id: unknown): string | undefined => {
    const hit = people.find((one) => one.data?.id === id)?.data;
    return hit ? `${hit.fullName} · ${hit.code}` : undefined;
  };

  const all = devices.data?.pages.flatMap((page) => page.rows) ?? [];
  const first = devices.data?.pages[0];
  const kioskOf = (id: unknown): string => {
    const hit = all.find((one) => one.id === id);
    return hit?.name ?? String(id ?? "");
  };

  function refreshFleet(): void {
    void cache.invalidateQueries({ queryKey: ["devices"] });
    void cache.invalidateQueries({ queryKey: ["releases"] });
  }

  const updateAll = useMutation({
    mutationFn: async () =>
      (
        await api.post<{ offered: string[]; failed: string[]; busy: string[]; offline: string[] }>(
          "/releases/update",
          movesRecognition ? { recapture: true } : {},
        )
      ).data,
    onSuccess: (done) => {
      setAsking(false);
      notify.done(
        t("releaseUpdateAllDone", {
          offered: done.offered.length,
          failed: done.failed.length,
          busy: done.busy.length,
          offline: done.offline.length,
        }),
      );
      void cache.invalidateQueries({ queryKey: ["releases"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const approve = useMutation({
    mutationFn: (device: Device) => api.post(`/devices/${device.id}/approve`, { claimCode: claim }),
    onSuccess: (_, device) => {
      setApproving(null);
      notify.done(t("approvedDone", { name: device.name ?? device.id }));
      refreshFleet();
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function startApproving(device: Device): void {
    setFault(null);
    setClaim("");
    setApproving(device);
  }

  // A punch or an event carries the kiosk's own clock; a status change only the moment of hearing it.
  const feedAt = (item: FeedItem) => new Date(typeof item.body.ts === "number" ? item.body.ts : item.heardAt);

  function punchFlag(item: FeedItem) {
    if (item.feed !== "attendance") {
      return null;
    }
    if (item.body.questionableTime === true) {
      return <StatePill tone="bad">{a("flagQuestionable")}</StatePill>;
    }
    return item.body.clockUnsynced === true ? <StatePill tone="waiting">{a("flagClock")}</StatePill> : null;
  }

  function detail(item: FeedItem): string {
    const body = item.body;
    if (item.feed === "attendance") {
      const way = body.direction === "OUT" ? t("dirOUT") : t("dirIN");
      return [personOf(body.employeeId) ?? t("feedPerson", { id: String(body.employeeId ?? "") }), way, kioskOf(body.deviceId)].join(" · ");
    }
    if (item.feed === "event") {
      const what = isDeviceEvent(body.type) ? t(`event_${body.type}`) : String(body.type ?? "");
      return [what, kioskOf(body.deviceId)].filter(Boolean).join(" · ");
    }
    const state =
      typeof body.online === "boolean" ? (body.online ? t("online") : t("offline")) : t(`status${body.status as Device["status"]}`);
    return [state, kioskOf(body.deviceId)].join(" · ");
  }

  const statusName = (status: Device["status"]) => t(`status${status}`);

  const columns: Column<Device>[] = [
    {
      id: "device",
      header: t("device"),
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className={row.name ? "truncate" : "truncate text-kumo-subtle"}>{row.name ?? t("unnamed")}</span>
          <span className="truncate font-mono text-sm text-kumo-subtle">{row.id}</span>
        </span>
      ),
    },
    {
      id: "status",
      header: t("status"),
      cell: (row) =>
        row.status === "APPROVED" ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <StatePill tone={row.online ? "good" : "idle"}>{row.online ? t("online") : t("offline")}</StatePill>
            {clockDrifts(row.clockSkewMs) ? <StatePill tone="waiting">{t("clockDrift")}</StatePill> : null}
          </span>
        ) : (
          <StatePill tone={STATUS_TONE[row.status]}>{statusName(row.status)}</StatePill>
        ),
    },
    {
      id: "lastSeen",
      header: t("lastSeen"),
      priority: 2,
      cell: (row) => (
        <span className="whitespace-nowrap tabular-nums">
          {row.lastSeenAt ? format.relativeTime(new Date(row.lastSeenAt), now) : t("never")}
        </span>
      ),
    },
    { id: "location", header: t("location"), priority: 3, truncate: true, cell: (row) => row.location ?? common("empty") },
    {
      id: "firmware",
      header: t("firmware"),
      priority: 3,
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm">{row.fwVersion ?? common("empty")}</span>
          {updating.includes(row.id) ? (
            <StatePill tone="waiting">{t("updatingBadge")}</StatePill>
          ) : behind.includes(row.id) || offline.includes(row.id) ? (
            <StatePill>{t("updateBadge")}</StatePill>
          ) : null}
        </span>
      ),
    },
  ];

  const actionsOf = (row: Device): RowAction[] =>
    row.status === "PENDING"
      ? [
          { key: "approve", label: t("approve"), icon: CheckCircleIcon, onSelect: () => startApproving(row) },
          { key: "open", label: t("openDetail"), icon: ArrowSquareOutIcon, onSelect: () => router.push(`/devices/${row.id}`) },
        ]
      : [];

  const history = releases.data ?? [];
  const tally = counts.data;
  const faultBanner = fault ? <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null;

  return (
    <>
      <PageHeader title={t("title")} description={t("leadShort")} />

      <PageLayout
        aside={
          <>
            <AsideCard title={t("releasesTitle")}>
              {fleet.isPending ? (
                <SkeletonLine minWidth={25} maxWidth={43} />
              ) : newestParts.length === 0 ? (
                <p className="text-pretty text-kumo-subtle">{t("releasesEmpty")}</p>
              ) : (
                <div className="flex flex-col gap-3">
                  <ul className="flex flex-col gap-1">
                    {newestParts.map((one) => (
                      <li key={one.releaseId} className="flex items-baseline justify-between gap-3">
                        <span className="font-medium">{t(`target${one.target}`)}</span>
                        <span className="font-mono text-sm">{one.version}</span>
                      </li>
                    ))}
                  </ul>
                  <span className="text-sm text-kumo-subtle">
                    {[
                      behind.length > 0 || updating.length + offline.length === 0
                        ? t("releaseBehind", { count: behind.length })
                        : null,
                      updating.length > 0 ? t("releaseUpdating", { count: updating.length }) : null,
                      offline.length > 0 ? t("releaseOffline", { count: offline.length }) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  <ReleaseSummary releases={newestParts} onOpen={() => setReading(newestParts)} />
                  {behind.length > 0 ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={ArrowsClockwiseIcon}
                      className="self-start"
                      disabled={updateAll.isPending}
                      onClick={() => {
                        setFault(null);
                        setAsking(true);
                      }}
                    >
                      {t("releaseUpdateAll", { count: behind.length })}
                    </Button>
                  ) : null}
                </div>
              )}
            </AsideCard>
            <AsideCard title={t("feedTitle")} action={<StatePill tone={LINK_TONE[link]}>{t(`link_${link}`)}</StatePill>}>
              {recent.length === 0 ? (
                <p className="text-kumo-subtle">{t("feedEmpty")}</p>
              ) : (
                <ul className="-my-1 flex flex-col">
                  {recent.map((item) => (
                    <li key={item.id} className="flex items-baseline gap-3 border-b border-kumo-hairline py-2 last:border-0">
                      <span className="min-w-11 shrink-0 text-sm whitespace-nowrap text-kumo-subtle tabular-nums">
                        {format.dateTime(feedAt(item), stampOptions(feedAt(item)))}
                      </span>
                      <span className="w-20 shrink-0 text-sm text-kumo-subtle">{t(FEED_KEY[item.feed])}</span>
                      <span className="min-w-0 flex-1 truncate" title={detail(item)}>
                        {detail(item)}
                      </span>
                      {punchFlag(item)}
                    </li>
                  ))}
                </ul>
              )}
            </AsideCard>
          </>
        }
        extra={
          history.length > 0 ? (
            <AsideCard title={t("releasesHistory")}>
              <ul className="-mx-2 -my-1 flex flex-col">
                {(wholeHistory ? history : history.slice(0, kHistoryShown)).map((one) => {
                  const notes = notesOf(one);
                  return (
                    <li key={one.releaseId}>
                      <button
                        type="button"
                        className="flex min-h-10 w-full flex-col gap-0.5 rounded-md px-2 py-2 text-start hover:bg-kumo-tint motion-press"
                        onClick={() => setReading([one])}
                      >
                        <span className="flex w-full items-baseline justify-between gap-3">
                          <span className="min-w-0 truncate">
                            {t(`target${one.target}`)} <span className="font-mono text-sm">{one.version}</span>
                          </span>
                          <span className="shrink-0 text-sm whitespace-nowrap text-kumo-subtle tabular-nums">
                            {format.dateTime(new Date(one.createdAt), "day")}
                            {one.available ? null : ` · ${t("releaseCleared")}`}
                          </span>
                        </span>
                        {notes ? (
                          <span className="line-clamp-2 text-sm text-pretty text-kumo-subtle">{headlineOf(notes)}</span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {history.length > kHistoryShown ? (
                <Button variant="ghost" size="sm" className="mt-2" onClick={() => setWholeHistory(!wholeHistory)}>
                  {wholeHistory ? common("less") : t("historyMore", { count: history.length - kHistoryShown })}
                </Button>
              ) : null}
              <p className="mt-3 text-sm text-pretty text-kumo-subtle">{t("releasesLead")}</p>
            </AsideCard>
          ) : undefined
        }
      >
        <FilterBar
          search={{ value: typed, onChange: setTyped, placeholder: t("searchHint") }}
          filters={[
            {
              key: "show",
              label: t("status"),
              value: show,
              onChange: (next) => setUrl({ show: showOf(next) }),
              items: {
                "": common("all"),
                online: t("showOnline"),
                offline: t("showOffline"),
                PENDING: statusName("PENDING"),
                APPROVED: statusName("APPROVED"),
                REVOKED: statusName("REVOKED"),
              },
              counts: tally
                ? {
                    "": tally.PENDING + tally.APPROVED + tally.REVOKED,
                    online: tally.online,
                    offline: tally.offline,
                    PENDING: tally.PENDING,
                    APPROVED: tally.APPROVED,
                    REVOKED: tally.REVOKED,
                  }
                : undefined,
            },
          ]}
        />
        <DataTable
          id="devices"
          cardLead="device"
          cardTrailing="status"
          columns={columns}
          rows={devices.data ? all : undefined}
          keyOf={(row) => row.id}
          pending={devices.isPending}
          failed={devices.isError}
          onRetry={() => void devices.refetch()}
          onRowClick={(row) => (row.status === "PENDING" ? startApproving(row) : router.push(`/devices/${row.id}`))}
          rowActions={actionsOf}
          empty={show || url.q ? t("noMatch") : t("empty")}
          emptyHint={show || url.q ? t("noMatchHint") : t("emptyHint")}
          paging={
            first
              ? {
                  shown: all.length,
                  total: first.total,
                  exact: first.totalIsExact,
                  onMore: devices.hasNextPage ? () => void devices.fetchNextPage() : undefined,
                  loading: devices.isFetchingNextPage,
                }
              : undefined
          }
        />
      </PageLayout>

      <LayerDialog.Root open={approving !== null} onOpenChange={(next) => !next && setApproving(null)} dismissDisabled={approve.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("approveTitle", { name: approving?.name ?? approving?.id ?? "" })}</LayerDialog.Title>
          <LayerDialog.Description>{t("approveLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-3">
              <Input
                label={t("claimLabel")}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder={t("claimPlaceholder")}
                value={claim}
                description={claim.length !== kClaimDigits ? t("claimHint", { digits: kClaimDigits }) : undefined}
                // Cut after the clean-up, never by maxLength: the browser would cut a pasted "123 456" to "123 45" first.
                onChange={(event) => setClaim(event.target.value.replace(/\D/g, "").slice(0, kClaimDigits))}
                className="font-mono tracking-widest tabular-nums"
              />
              {approving ? (
                <p className="text-sm text-kumo-subtle">{[approving.id, approving.location].filter(Boolean).join(" · ")}</p>
              ) : null}
              {faultBanner}
            </div>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              loading={approve.isPending}
              disabled={claim.length !== kClaimDigits}
              onClick={() => approving && approve.mutate(approving)}
            >
              {t("approve")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Alert open={asking} onOpenChange={(next) => !next && setAsking(false)} dismissDisabled={updateAll.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("releaseUpdateAllTitle")}</LayerDialog.Title>
          <LayerDialog.Description>{t("releaseUpdateAllAsk", { count: behind.length, parts: partsText })}</LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-3">
              {movesRecognition ? (
                <Banner
                  variant="alert"
                  icon={<WarningIcon weight="fill" />}
                  description={t("releaseRecaptureWarning")}
                  className="text-pretty"
                />
              ) : null}
              {newestParts.some((one) => notesOf(one)) ? (
                <div className="max-h-56 overflow-y-auto rounded-lg border border-kumo-hairline p-3">
                  <ReleaseNotesParts releases={newestParts} />
                </div>
              ) : null}
              {offline.length > 0 ? (
                <p className="text-sm text-pretty text-kumo-subtle">{t("releaseUpdateAllOffline", { count: offline.length })}</p>
              ) : null}
              <ul className="flex flex-col">
                {behind.map((id) => (
                  <li key={id} className="flex justify-between gap-3 border-b border-kumo-hairline py-1.5 last:border-0">
                    <span>{kioskOf(id)}</span>
                    <span className="font-mono text-sm text-kumo-subtle">{id}</span>
                  </li>
                ))}
              </ul>
              {faultBanner}
            </div>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary variant="destructive" loading={updateAll.isPending} onClick={() => updateAll.mutate()}>
              {t(movesRecognition ? "releaseRecaptureConfirm" : "releaseUpdateAll", { count: behind.length })}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>

      <ReleaseNotesDialog releases={reading} onClose={() => setReading(null)} />
    </>
  );
}

export default function DevicesPage() {
  return (
    <Suspense>
      <Devices />
    </Suspense>
  );
}
