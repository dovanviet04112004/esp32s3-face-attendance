"use client";

import { useQuery } from "@tanstack/react-query";
import { useFormatter, useNow, useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { useWaitingCount } from "@/components/nav/waiting-count";
import { Button } from "@/components/ui/button";
import { Failed } from "@/components/ui/empty";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { useFeed, type FeedItem } from "@/lib/ws";

type ExceptionReason = "NO_PUNCH" | "LATE" | "STILL_IN";

interface Expiring {
  contractId: string;
  employeeId: number;
  code: string;
  fullName: string;
  endsOn: string;
  daysLeft: number;
}

interface Exception {
  employeeId: number;
  code: string;
  fullName: string;
  reason: ExceptionReason;
  minutes: number;
}

interface Heap<T> {
  rows: T[];
  total: number;
  totalIsExact: boolean;
}

interface Attention {
  contractsEnding: Heap<Expiring>;
  probationEnding: Heap<Expiring>;
  exceptionsToday: Heap<Exception>;
}

const REASON_KEY: Record<ExceptionReason, "reasonNO_PUNCH" | "reasonLATE" | "reasonSTILL_IN"> = {
  NO_PUNCH: "reasonNO_PUNCH",
  LATE: "reasonLATE",
  STILL_IN: "reasonSTILL_IN",
};

type DeviceStatus = "PENDING" | "APPROVED" | "REVOKED";

interface DevicePage {
  rows: { id: string; name: string | null; status: DeviceStatus; online: boolean }[];
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

const FEED_KEY: Record<FeedItem["feed"], "feedAttendance" | "feedEvent" | "feedDevice"> = {
  attendance: "feedAttendance",
  event: "feedEvent",
  device: "feedDevice",
};

const kPileRows = 6;
const kFleetCards = 6;
const kClockMs = 60_000;
const kAttentionMs = 300_000;

/** Every block wears the same shell, so the page reads as one surface rather
 *  than three that each invented their own edge.
 */
function Panel({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface)">
      <div className="flex items-baseline justify-between gap-3 border-b border-(--color-line) px-4 py-3">
        <h2 className="text-sm font-medium">{title}</h2>
        {aside}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

interface PileProps<T> {
  title: string;
  hint?: string;
  heap: Heap<T>;
  keyOf: (row: T) => string;
  href: (row: T) => string;
  name: (row: T) => string;
  aside: (row: T) => string;
  numeric?: boolean;
}

/** One column of what needs attention, which says so when it holds back rows.
 *  The rows keep a reading width of their own: stretched across a third of a
 *  wide screen, a name and its number stop looking like one fact.
 */
function Pile<T>({ title, hint, heap, keyOf, href, name, aside, numeric }: PileProps<T>) {
  const common = useTranslations("common");
  const shown = heap.rows.slice(0, kPileRows);
  return (
    <div>
      <p className="text-xs font-medium text-(--color-warn) uppercase">{title}</p>
      <ul className="mt-2 flex max-w-sm flex-col gap-0.5 text-sm">
        {shown.map((row) => (
          <li key={keyOf(row)} className="flex justify-between gap-3 py-1 pointer-coarse:min-h-11">
            <Link href={href(row)} className="truncate underline hover:no-underline">
              {name(row)}
            </Link>
            <span className={cn("shrink-0", numeric ? "tabular-nums" : "text-(--color-muted)")}>
              {aside(row)}
            </span>
          </li>
        ))}
      </ul>
      {heap.total > shown.length ? (
        <p className="mt-1.5 text-xs text-(--color-muted) tabular-nums">
          {common(heap.totalIsExact ? "showingOf" : "showingOfAtLeast", {
            shown: shown.length,
            total: heap.total,
          })}
        </p>
      ) : null}
      {hint ? <p className="mt-2 max-w-sm text-xs text-(--color-muted)">{hint}</p> : null}
    </div>
  );
}

function detail(item: FeedItem, t: (key: "dirIN" | "dirOUT") => string): string {
  const body = item.body;
  if (item.feed === "attendance") {
    const way = body.direction === "OUT" ? t("dirOUT") : t("dirIN");
    return [way, body.deviceId].filter(Boolean).join(" · ");
  }
  const parts = [body.type ?? (body.online === undefined ? undefined : body.online), body.deviceId];
  return parts.filter((part) => part !== undefined && part !== null).join(" · ");
}

export default function OverviewPage() {
  const t = useTranslations("overview");
  const common = useTranslations("common");
  const dev = useTranslations("devices");
  const format = useFormatter();
  const now = useNow({ updateInterval: kClockMs });
  const { status, items } = useFeed();
  const role = useSession((s) => s.role);
  // The day's work reaches three roles; the fleet beside it reaches one.
  const runsTheFleet = role === "ADMIN";
  const waitingOnMe = useWaitingCount(role);

  const attention = useQuery({
    queryKey: ["reports", "attention"],
    refetchInterval: kAttentionMs,
    queryFn: async () => (await api.get<Attention>("/reports/attention")).data,
  });
  const waiting = attention.data;

  const devices = useQuery({
    queryKey: ["devices"],
    enabled: runsTheFleet,
    queryFn: async () => (await api.get<DevicePage>("/devices")).data,
  });

  if (attention.isError) {
    return <Failed onRetry={() => void attention.refetch()} />;
  }

  const piles = waiting
    ? [
        {
          key: "contracts",
          node: (
            <Pile
              title={t("contractsEnding")}
              hint={t("contractsHint")}
              heap={waiting.contractsEnding}
              keyOf={(row: Expiring) => row.contractId}
              href={(row: Expiring) => `/employees/${row.employeeId}?tab=contracts`}
              name={(row: Expiring) => row.fullName}
              aside={(row: Expiring) => t("daysLeft", { count: row.daysLeft })}
              numeric
            />
          ),
          rows: waiting.contractsEnding.rows.length,
        },
        {
          key: "probation",
          node: (
            <Pile
              title={t("probationEnding")}
              hint={t("probationHint")}
              heap={waiting.probationEnding}
              keyOf={(row: Expiring) => row.contractId}
              href={(row: Expiring) => `/employees/${row.employeeId}?tab=contracts`}
              name={(row: Expiring) => row.fullName}
              aside={(row: Expiring) => t("daysLeft", { count: row.daysLeft })}
              numeric
            />
          ),
          rows: waiting.probationEnding.rows.length,
        },
        {
          key: "exceptions",
          node: (
            <Pile
              title={t("exceptionsToday")}
              heap={waiting.exceptionsToday}
              keyOf={(row: Exception) => String(row.employeeId)}
              href={(row: Exception) => `/attendance/${row.employeeId}`}
              name={(row: Exception) => row.fullName}
              aside={(row: Exception) => t(REASON_KEY[row.reason])}
            />
          ),
          rows: waiting.exceptionsToday.rows.length,
        },
      ].filter((one) => one.rows > 0)
    : [];

  const fleet = devices.data?.rows ?? [];

  return (
    <section className="pb-4">
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-0.5 text-sm text-(--color-muted)">{format.dateTime(now, "day")}</p>

      <Panel title={t("waitingTitle")}>
        {waitingOnMe > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-sm">
              <span className="text-3xl font-semibold tabular-nums">{waitingOnMe}</span>{" "}
              {t("waitingCount", { count: waitingOnMe })}
            </p>
            <Link href="/approvals">
              <Button size="sm">{t("waitingGo")}</Button>
            </Link>
          </div>
        ) : (
          <p className="text-sm text-(--color-ok)">{t("waitingNone")}</p>
        )}
      </Panel>

      <Panel title={t("attention")}>
        {attention.isPending ? (
          <SkeletonRows rows={2} columns={2} />
        ) : piles.length === 0 ? (
          <p className="text-sm text-(--color-ok)">{t("attentionClear")}</p>
        ) : (
          <div
            className={cn(
              "grid gap-6",
              piles.length === 2 && "md:grid-cols-2",
              piles.length > 2 && "md:grid-cols-2 lg:grid-cols-3",
            )}
          >
            {piles.map((one) => (
              <div key={one.key}>{one.node}</div>
            ))}
          </div>
        )}
      </Panel>

      {runsTheFleet ? (
        <div className="grid lg:grid-cols-2 lg:gap-x-4">
        <Panel
          title={t("fleetTitle")}
          aside={
            <span className="text-xs text-(--color-muted) tabular-nums">
              {devices.isPending ? common("loading") : t("deviceCount", { count: devices.data?.total ?? 0 })}
            </span>
          }
        >
          {devices.isPending ? (
            <SkeletonRows rows={2} columns={2} />
          ) : (
            <>
              <ul className="grid gap-3 sm:grid-cols-2">
                {fleet.slice(0, kFleetCards).map((device) => (
                  <li
                    key={device.id}
                    className="rounded-lg border border-(--color-line) bg-(--color-ground) p-3"
                  >
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          device.online ? "bg-(--color-ok)" : "bg-(--color-muted)",
                        )}
                        aria-hidden
                      />
                      <span className="truncate">{device.name ?? device.id}</span>
                    </p>
                    <p className="mt-1.5 text-xs text-(--color-muted)">
                      {device.online ? t("online") : t("offline")} · {dev(`status${device.status}`)}
                    </p>
                  </li>
                ))}
              </ul>
              {(devices.data?.total ?? 0) > kFleetCards ? (
                <Link
                  href="/devices"
                  className="mt-3 inline-block text-sm text-(--color-accent) hover:underline"
                >
                  {common("seeAll")}
                </Link>
              ) : null}
            </>
          )}
        </Panel>
        <Panel
          title={t("feedTitle")}
          aside={<span className={cn("text-xs", STATUS_TONE[status])}>{t(status)}</span>}
        >
          {items.length === 0 ? (
            <p className="text-sm text-(--color-muted)">{t("feedEmpty")}</p>
          ) : (
            <ul className="-my-1 flex flex-col divide-y divide-(--color-line)">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-3 py-2 text-sm pointer-coarse:min-h-11"
                >
                  <span className={cn("size-2 shrink-0 rounded-full", DOT[item.feed])} aria-hidden />
                  <span className="w-12 shrink-0 text-xs text-(--color-muted) tabular-nums">
                    {typeof item.body.ts === "number"
                      ? format.dateTime(new Date(item.body.ts), "clock")
                      : ""}
                  </span>
                  <span className="w-20 shrink-0 text-(--color-muted)">{t(FEED_KEY[item.feed])}</span>
                  <span className="min-w-0 flex-1 truncate">{detail(item, t)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        </div>
      ) : null}
    </section>
  );
}
