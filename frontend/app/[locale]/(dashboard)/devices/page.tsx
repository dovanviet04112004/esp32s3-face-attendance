"use client";

import { Button, Input, LayerDialog, SkeletonLine } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, ArrowsClockwiseIcon, CheckCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { DataTable, type Column, type RowAction } from "@/components/tables/data-table";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, PageHeader, PageLayout, StatList } from "@/components/ui/page";
import { StatePill, type Tone } from "@/components/ui/pill";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";

interface Release {
  releaseId: string;
  target: "FIRMWARE" | "MODELS";
  version: string;
  sizeBytes: number;
  createdAt: string;
  available: boolean;
}

/** The newest release of one kind and the approved kiosks behind it; the server owns the rule. */
interface FleetUpdate {
  release: Release;
  behind: string[];
  updating: string[];
}

interface Device {
  id: string;
  name: string | null;
  location: string | null;
  status: "PENDING" | "APPROVED" | "REVOKED";
  fwVersion: string | null;
  rosterVersion: number;
  online: boolean;
}

const SHOWS = ["", "online", "offline", "PENDING", "APPROVED", "REVOKED"] as const;
type Show = (typeof SHOWS)[number];

const STATUS_TONE: Record<Device["status"], Tone> = { PENDING: "waiting", APPROVED: "good", REVOKED: "idle" };

const FLEET_POLL_MS = 5_000;
const kFleetTake = 200;
const kHistoryShown = 6;
const kClaimDigits = 6;

function showOf(raw: string | null): Show {
  const held = raw ?? "";
  return (SHOWS as readonly string[]).includes(held) ? (held as Show) : "";
}

function fits(row: Device, show: Show): boolean {
  if (show === "online") {
    return row.status === "APPROVED" && row.online;
  }
  if (show === "offline") {
    return row.status === "APPROVED" && !row.online;
  }
  return show === "" || row.status === show;
}

export default function DevicesPage() {
  const t = useTranslations("devices");
  const common = useTranslations("common");
  const format = useFormatter();
  const cache = useQueryClient();
  const router = useRouter();
  const notify = useNotify();
  const faultOf = useFault();
  const asked = useSearchParams().get("show");
  const isAdmin = useSession((s) => s.role) === "ADMIN";

  const [show, setShow] = useState<Show>(() => showOf(asked));
  const [typed, setTyped] = useState("");
  const search = useSettled(typed.trim().toLowerCase());
  const [asking, setAsking] = useState<FleetUpdate | null>(null);
  const [approving, setApproving] = useState<Device | null>(null);
  const [claim, setClaim] = useState("");
  const [fault, setFault] = useState<string | null>(null);
  const [wholeHistory, setWholeHistory] = useState(false);

  // While any kiosk installs, both lists follow it until it returns on the new version.
  const installing = (): number | false =>
    (cache.getQueryData<FleetUpdate[]>(["releases", "fleet"]) ?? []).some((one) => one.updating.length > 0)
      ? FLEET_POLL_MS
      : false;
  const devices = useQuery({
    queryKey: ["devices", { take: kFleetTake }],
    enabled: isAdmin,
    queryFn: async () => (await api.get<{ rows: Device[]; total: number }>(`/devices?take=${kFleetTake}`)).data,
    refetchInterval: installing,
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

  const updateAll = useMutation({
    mutationFn: async (releaseId: string) =>
      (await api.post<{ offered: string[]; failed: string[]; busy: string[] }>(`/releases/${releaseId}/offer`, {})).data,
    onSuccess: (done) => {
      setAsking(null);
      notify.done(t("releaseUpdateAllDone", { offered: done.offered.length, failed: done.failed.length, busy: done.busy.length }));
      void cache.invalidateQueries({ queryKey: ["releases"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const approve = useMutation({
    mutationFn: (device: Device) => api.post(`/devices/${device.id}/approve`, { claimCode: claim }),
    onSuccess: (_, device) => {
      setApproving(null);
      notify.done(t("approvedDone", { name: device.name ?? device.id }));
      void cache.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function startApproving(device: Device): void {
    setFault(null);
    setClaim("");
    setApproving(device);
  }

  const all = devices.data?.rows ?? [];
  const nameOf = (id: string) => all.find((one) => one.id === id)?.name ?? id;
  const approved = all.filter((one) => one.status === "APPROVED");
  const online = approved.filter((one) => one.online).length;
  const pending = all.filter((one) => one.status === "PENDING").length;
  const shown = all.filter(
    (row) =>
      fits(row, show) &&
      (search === "" || [row.name, row.id, row.location].some((field) => field?.toLowerCase().includes(search))),
  );

  const updatesFor = (deviceId: string): FleetUpdate[] =>
    (fleet.data ?? []).filter((update) => update.behind.includes(deviceId) || update.updating.includes(deviceId));

  const statusName = (status: Device["status"]) => t(`status${status}`);

  const columns: Column<Device>[] = [
    {
      id: "device",
      header: t("device"),
      sticky: true,
      sortBy: (row) => row.name ?? row.id,
      cell: (row) => (
        <span className="flex flex-col whitespace-nowrap">
          <span className={row.name ? undefined : "text-kumo-subtle"}>{row.name ?? t("unnamed")}</span>
          <span className="font-mono text-sm text-kumo-subtle">{row.id}</span>
        </span>
      ),
    },
    {
      id: "status",
      header: t("status"),
      sortBy: (row) => (row.status === "APPROVED" ? (row.online ? "A" : "B") : row.status),
      cell: (row) =>
        row.status === "APPROVED" ? (
          <StatePill tone={row.online ? "good" : "idle"}>{row.online ? t("online") : t("offline")}</StatePill>
        ) : (
          <StatePill tone={STATUS_TONE[row.status]}>{statusName(row.status)}</StatePill>
        ),
    },
    {
      id: "location",
      header: t("location"),
      sortBy: (row) => row.location ?? "",
      cell: (row) => row.location ?? common("empty"),
    },
    {
      id: "firmware",
      header: t("firmware"),
      sortBy: (row) => row.fwVersion ?? "",
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm">{row.fwVersion ?? common("empty")}</span>
          {updatesFor(row.id).map((update) =>
            update.updating.includes(row.id) ? (
              <StatePill key={update.release.releaseId} tone="waiting">
                {t("updatingBadge", { version: update.release.version })}
              </StatePill>
            ) : (
              <StatePill key={update.release.releaseId}>
                {t("updateBadge", { target: t(`target${update.release.target}`), version: update.release.version })}
              </StatePill>
            ),
          )}
        </span>
      ),
    },
    {
      id: "roster",
      header: t("roster"),
      numeric: true,
      sortBy: (row) => row.rosterVersion,
      cell: (row) => row.rosterVersion,
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

  return (
    <>
      <PageHeader title={t("title")} description={t("leadShort")} />

      <PageLayout
        aside={
          <>
            <AsideCard title={common("summary")}>
              <StatList
                stats={[
                  {
                    key: "online",
                    label: t("showOnline"),
                    value: devices.data ? `${online} / ${approved.length}` : common("empty"),
                    active: show === "online",
                    onPick: () => setShow("online"),
                    tone: devices.data && online < approved.length ? "warning" : undefined,
                  },
                  {
                    key: "pending",
                    label: statusName("PENDING"),
                    value: devices.data ? pending : common("empty"),
                    active: show === "PENDING",
                    onPick: () => setShow("PENDING"),
                    tone: pending > 0 ? "warning" : undefined,
                  },
                  {
                    key: "all",
                    label: common("all"),
                    value: devices.data ? all.length : common("empty"),
                    active: show === "",
                    onPick: () => setShow(""),
                  },
                ]}
              />
            </AsideCard>
            <AsideCard title={t("releasesTitle")}>
              {fleet.isPending ? (
                <SkeletonLine minWidth={120} maxWidth={260} />
              ) : (fleet.data ?? []).length === 0 ? (
                <p className="text-pretty text-kumo-subtle">{t("releasesEmpty")}</p>
              ) : (
                <ul className="-my-1 flex flex-col">
                  {(fleet.data ?? []).map((update) => (
                    <li
                      key={update.release.releaseId}
                      className="flex flex-col gap-2 border-b border-kumo-hairline py-3 first:pt-1 last:border-0 last:pb-1"
                    >
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="font-medium">{t(`target${update.release.target}`)}</span>
                        <span className="font-mono text-sm">{update.release.version}</span>
                      </span>
                      <span className="text-sm text-kumo-subtle">
                        {[
                          update.behind.length > 0 || update.updating.length === 0
                            ? t("releaseBehind", { count: update.behind.length })
                            : null,
                          update.updating.length > 0 ? t("releaseUpdating", { count: update.updating.length }) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      {update.behind.length > 0 ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={ArrowsClockwiseIcon}
                          className="self-start"
                          disabled={updateAll.isPending}
                          onClick={() => {
                            setFault(null);
                            setAsking(update);
                          }}
                        >
                          {t("releaseUpdateAll", { count: update.behind.length })}
                        </Button>
                      ) : null}
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
              <ul className="-my-1 flex flex-col">
                {(wholeHistory ? history : history.slice(0, kHistoryShown)).map((one) => (
                  <li
                    key={one.releaseId}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-kumo-hairline py-2 last:border-0"
                  >
                    <span className="w-20 shrink-0">{t(`target${one.target}`)}</span>
                    <span className="font-mono text-sm">{one.version}</span>
                    <span className="ms-auto text-sm text-kumo-subtle tabular-nums">
                      {format.dateTime(new Date(one.createdAt), "day")} ·{" "}
                      {one.available ? t("releaseSize", { kb: Math.round(one.sizeBytes / 1024) }) : t("releaseCleared")}
                    </span>
                  </li>
                ))}
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
              onChange: (next) => setShow(showOf(next)),
              items: {
                "": common("all"),
                online: t("showOnline"),
                offline: t("showOffline"),
                PENDING: statusName("PENDING"),
                APPROVED: statusName("APPROVED"),
                REVOKED: statusName("REVOKED"),
              },
            },
          ]}
        />
        <DataTable
          id="devices"
          cardLead="device"
          columns={columns}
          rows={shown}
          keyOf={(row) => row.id}
          pending={devices.isPending}
          failed={devices.isError}
          onRetry={() => void devices.refetch()}
          onRowClick={(row) => (row.status === "PENDING" ? startApproving(row) : router.push(`/devices/${row.id}`))}
          rowActions={actionsOf}
          empty={show || search ? t("noMatch") : t("empty")}
          emptyHint={show || search ? t("noMatchHint") : t("emptyHint")}
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
                maxLength={kClaimDigits}
                onChange={(event) => setClaim(event.target.value.replace(/\D/g, "").slice(0, kClaimDigits))}
                className="font-mono tracking-widest tabular-nums"
              />
              {approving ? (
                <p className="text-sm text-kumo-subtle">
                  {[approving.id, approving.location].filter(Boolean).join(" · ")}
                </p>
              ) : null}
              {fault ? <p className="text-kumo-danger">{fault}</p> : null}
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

      <LayerDialog.Alert open={asking !== null} onOpenChange={(next) => !next && setAsking(null)} dismissDisabled={updateAll.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>
            {asking
              ? t("releaseUpdateAllTitle", { target: t(`target${asking.release.target}`), version: asking.release.version })
              : ""}
          </LayerDialog.Title>
          <LayerDialog.Description>
            {asking
              ? t("releaseUpdateAllAsk", {
                  count: asking.behind.length,
                  target: t(`target${asking.release.target}`),
                  version: asking.release.version,
                })
              : ""}
          </LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-3">
              {asking ? (
                <ul className="flex flex-col">
                  {asking.behind.map((id) => (
                    <li key={id} className="flex justify-between gap-3 border-b border-kumo-hairline py-1.5 last:border-0">
                      <span>{nameOf(id)}</span>
                      <span className="font-mono text-sm text-kumo-subtle">{id}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {fault ? <p className="text-kumo-danger">{fault}</p> : null}
            </div>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              variant="destructive"
              loading={updateAll.isPending}
              onClick={() => asking && updateAll.mutate(asking.release.releaseId)}
            >
              {asking ? t("releaseUpdateAll", { count: asking.behind.length }) : ""}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </>
  );
}
