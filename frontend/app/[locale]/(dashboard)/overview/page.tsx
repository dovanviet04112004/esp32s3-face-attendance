"use client";

import { Empty, LayerCard, LinkButton, SkeletonLine } from "@cloudflare/kumo";
import { CaretRightIcon, CheckCircleIcon, TrayIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useFormatter, useNow, useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { useWaitingCount } from "@/components/nav/waiting-count";
import { Failed } from "@/components/ui/failed";
import { AsideCard, PageHeader, PageLayout, StatList, type Stat } from "@/components/ui/page";
import { CountPill, StatePill, type Tone } from "@/components/ui/pill";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession, type Role } from "@/lib/auth";
import { useFeed, type FeedItem, type FeedStatus } from "@/lib/ws";

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

interface Period {
  id: string;
  year: number;
  month: number;
  state: "OPEN" | "LOCKED" | "PAID";
}

interface Device {
  id: string;
  status: "PENDING" | "APPROVED" | "REVOKED";
  online: boolean;
}

interface FleetUpdate {
  behind: string[];
  updating: string[];
}

const REASON_KEY: Record<ExceptionReason, "reasonNO_PUNCH" | "reasonLATE" | "reasonSTILL_IN"> = {
  NO_PUNCH: "reasonNO_PUNCH",
  LATE: "reasonLATE",
  STILL_IN: "reasonSTILL_IN",
};

const REASON_TONE: Record<ExceptionReason, Tone> = { NO_PUNCH: "bad", LATE: "waiting", STILL_IN: "waiting" };

const FEED_KEY: Record<FeedItem["feed"], "feedAttendance" | "feedEvent" | "feedDevice"> = {
  attendance: "feedAttendance",
  event: "feedEvent",
  device: "feedDevice",
};

const LINK_TONE: Record<FeedStatus, Tone> = { live: "good", reconnecting: "waiting", dropped: "bad" };

const HIRERS: Role[] = ["ADMIN", "HR"];
const kPileRows = 6;
const kFeedRows = 12;
const kFleetTake = 200;
const kClockMs = 60_000;
const kAttentionMs = 300_000;

function periodName(period: { year: number; month: number }): string {
  return `${String(period.month).padStart(2, "0")}/${period.year}`;
}

interface PileProps<T> {
  title: string;
  hint?: string;
  heap: Heap<T>;
  keyOf: (row: T) => string;
  href: (row: T) => string;
  name: (row: T) => string;
  code: (row: T) => string;
  aside: (row: T) => ReactNode;
}

/** One kind of work due today; every row opens where it is handled. */
function Pile<T>({ title, hint, heap, keyOf, href, name, code, aside }: PileProps<T>) {
  const common = useTranslations("common");
  const shown = heap.rows.slice(0, kPileRows);
  return (
    <LayerCard>
      <LayerCard.Secondary className="justify-between">
        <span>{title}</span>
        <CountPill>{heap.total}</CountPill>
      </LayerCard.Secondary>
      <LayerCard.Primary>
        <ul className="-mx-2 -my-1 flex flex-col">
          {shown.map((row) => (
            <li key={keyOf(row)}>
              <Link
                href={href(row)}
                className="flex min-h-9 items-center justify-between gap-3 rounded-md px-2 hover:bg-kumo-tint"
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate">{name(row)}</span>
                  <span className="shrink-0 font-mono text-sm text-kumo-subtle">{code(row)}</span>
                </span>
                <span className="shrink-0 tabular-nums">{aside(row)}</span>
              </Link>
            </li>
          ))}
        </ul>
        {heap.total > shown.length ? (
          <p className="mt-2 text-sm text-kumo-subtle tabular-nums">
            {common(heap.totalIsExact ? "showingOf" : "showingOfAtLeast", { shown: shown.length, total: heap.total })}
          </p>
        ) : null}
        {hint ? <p className="mt-2 text-sm text-pretty text-kumo-subtle">{hint}</p> : null}
      </LayerCard.Primary>
    </LayerCard>
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
  const format = useFormatter();
  const now = useNow({ updateInterval: kClockMs });
  const { status, items } = useFeed();
  const role = useSession((s) => s.role);
  const runsTheFleet = role === "ADMIN";
  const waitingOnMe = useWaitingCount(role);

  const attention = useQuery({
    queryKey: ["reports", "attention"],
    refetchInterval: kAttentionMs,
    queryFn: async () => (await api.get<Attention>("/reports/attention")).data,
  });

  const periods = useQuery({
    queryKey: ["payroll-periods"],
    enabled: role !== null,
    queryFn: async () => (await api.get<Period[]>("/payroll-periods")).data,
  });

  const devices = useQuery({
    queryKey: ["devices", { take: kFleetTake }],
    enabled: runsTheFleet,
    queryFn: async () => (await api.get<{ rows: Device[]; total: number }>(`/devices?take=${kFleetTake}`)).data,
  });

  const fleet = useQuery({
    queryKey: ["releases", "fleet"],
    enabled: runsTheFleet,
    queryFn: async () => (await api.get<FleetUpdate[]>("/releases/fleet")).data,
  });

  const waiting = attention.data;
  const piles = waiting
    ? [
        waiting.contractsEnding.total > 0 ? (
          <Pile
            key="contracts"
            title={t("contractsEnding")}
            hint={t("contractsHint")}
            heap={waiting.contractsEnding}
            keyOf={(row) => row.contractId}
            href={(row) => `/employees/${row.employeeId}?tab=contracts`}
            name={(row) => row.fullName}
            code={(row) => row.code}
            aside={(row) => t("daysLeft", { count: row.daysLeft })}
          />
        ) : null,
        waiting.probationEnding.total > 0 ? (
          <Pile
            key="probation"
            title={t("probationEnding")}
            hint={t("probationHint")}
            heap={waiting.probationEnding}
            keyOf={(row) => row.contractId}
            href={(row) => `/employees/${row.employeeId}?tab=contracts`}
            name={(row) => row.fullName}
            code={(row) => row.code}
            aside={(row) => t("daysLeft", { count: row.daysLeft })}
          />
        ) : null,
        waiting.exceptionsToday.total > 0 ? (
          <Pile
            key="exceptions"
            title={t("exceptionsToday")}
            heap={waiting.exceptionsToday}
            keyOf={(row) => String(row.employeeId)}
            href={(row) => `/attendance/${row.employeeId}`}
            name={(row) => row.fullName}
            code={(row) => row.code}
            aside={(row) => <StatePill tone={REASON_TONE[row.reason]}>{t(REASON_KEY[row.reason])}</StatePill>}
          />
        ) : null,
      ].filter((one) => one !== null)
    : [];

  const openPeriod = periods.data?.find((one) => one.state === "OPEN");
  const shortcuts: Stat[] = [
    ...(role !== null && HIRERS.includes(role)
      ? [{ key: "hire", label: t("shortcutHire"), value: <CaretRightIcon size={14} className="text-kumo-subtle" aria-hidden />, href: "/employees/new" }]
      : []),
    {
      key: "timesheet",
      label: t("shortcutTimesheet"),
      value: format.dateTime(now, { month: "long" }),
      href: "/timesheet",
    },
    {
      key: "payroll",
      label: t("shortcutPeriod"),
      value: openPeriod ? periodName(openPeriod) : t("shortcutPeriodNone"),
      href: openPeriod ? `/payroll/${openPeriod.id}` : "/payroll",
    },
  ];

  const kiosks = devices.data?.rows ?? [];
  const approved = kiosks.filter((one) => one.status === "APPROVED");
  const online = approved.filter((one) => one.online).length;
  const pending = kiosks.filter((one) => one.status === "PENDING").length;
  const behind = new Set((fleet.data ?? []).flatMap((one) => [...one.behind, ...one.updating])).size;
  const fleetStats: Stat[] = [
    {
      key: "online",
      label: t("kiosksOnline"),
      value: devices.data ? `${online} / ${approved.length}` : common("empty"),
      href: "/devices?show=online",
      tone: devices.data && online < approved.length ? "warning" : undefined,
    },
    {
      key: "pending",
      label: t("kiosksPending"),
      value: devices.data ? pending : common("empty"),
      href: "/devices?show=PENDING",
      tone: pending > 0 ? "warning" : undefined,
    },
    {
      key: "behind",
      label: t("kiosksBehind"),
      value: fleet.data ? behind : common("empty"),
      href: "/devices",
    },
  ];

  return (
    <>
      <PageHeader title={t("title")} description={format.dateTime(now, "day")} />

      <PageLayout
        aside={
          <>
            <AsideCard title={common("shortcuts")}>
              <StatList stats={shortcuts} />
            </AsideCard>
            {runsTheFleet ? (
              <AsideCard title={t("fleetTitle")}>
                <StatList stats={fleetStats} />
              </AsideCard>
            ) : null}
          </>
        }
        extra={
          runsTheFleet ? (
            <AsideCard title={t("feedTitle")} action={<StatePill tone={LINK_TONE[status]}>{t(status)}</StatePill>}>
              {items.length === 0 ? (
                <p className="text-kumo-subtle">{t("feedEmpty")}</p>
              ) : (
                <ul className="-my-1 flex flex-col">
                  {items.slice(0, kFeedRows).map((item) => (
                    <li
                      key={item.id}
                      className="flex items-baseline gap-3 border-b border-kumo-hairline py-2 last:border-0"
                    >
                      <span className="w-11 shrink-0 text-sm text-kumo-subtle tabular-nums">
                        {typeof item.body.ts === "number" ? format.dateTime(new Date(item.body.ts), "clock") : ""}
                      </span>
                      <span className="w-20 shrink-0 text-sm text-kumo-subtle">{t(FEED_KEY[item.feed])}</span>
                      <span className="min-w-0 flex-1 truncate">{detail(item, t)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </AsideCard>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-6">
          <LayerCard>
            <LayerCard.Secondary>{t("waitingTitle")}</LayerCard.Secondary>
            <LayerCard.Primary>
              {waitingOnMe > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p>
                    <span className="text-lg font-semibold tabular-nums">{format.number(waitingOnMe)}</span>{" "}
                    {t("waitingCount", { count: waitingOnMe })}
                  </p>
                  <LinkButton href="/approvals" variant="secondary" icon={TrayIcon}>
                    {t("waitingGo")}
                  </LinkButton>
                </div>
              ) : (
                <p className="text-kumo-subtle">{t("waitingNone")}</p>
              )}
            </LayerCard.Primary>
          </LayerCard>

          <section className="flex flex-col gap-3">
            <h2 className="m-0 text-lg font-semibold">{t("attention")}</h2>
            {attention.isError ? (
              <Failed onRetry={() => void attention.refetch()} />
            ) : attention.isPending ? (
              <LayerCard className="flex flex-col gap-3 p-4">
                {Array.from({ length: 4 }, (_, at) => (
                  <SkeletonLine key={at} minWidth={25} maxWidth={53} />
                ))}
              </LayerCard>
            ) : piles.length === 0 ? (
              <LayerCard className="p-0">
                <Empty
                  icon={<CheckCircleIcon size={40} className="text-kumo-inactive" />}
                  title={t("attentionClear")}
                  description={t("attentionClearHint")}
                  className="py-10"
                />
              </LayerCard>
            ) : (
              piles
            )}
          </section>
        </div>
      </PageLayout>
    </>
  );
}
