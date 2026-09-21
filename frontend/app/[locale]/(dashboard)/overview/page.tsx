"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { Failed } from "@/components/ui/empty";
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

interface Attention {
  contractsEnding: Expiring[];
  probationEnding: Expiring[];
  exceptionsToday: Exception[];
}

const REASON_KEY: Record<ExceptionReason, "reasonNO_PUNCH" | "reasonLATE" | "reasonSTILL_IN"> = {
  NO_PUNCH: "reasonNO_PUNCH",
  LATE: "reasonLATE",
  STILL_IN: "reasonSTILL_IN",
};

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
  const role = useSession((s) => s.role);
  const mayRead = role === "ADMIN" || role === "HR" || role === "PAYROLL";
  // The day's work reaches three roles; the fleet beside it reaches one.
  const runsTheFleet = role === "ADMIN";
  const attention = useQuery({
    queryKey: ["reports", "attention"],
    enabled: mayRead,
    refetchInterval: 300_000,
    queryFn: async () => (await api.get<Attention>("/reports/attention")).data,
  });
  const waiting = attention.data;
  const quiet =
    waiting !== undefined &&
    waiting.contractsEnding.length === 0 &&
    waiting.probationEnding.length === 0 &&
    waiting.exceptionsToday.length === 0;
  const devices = useQuery({
    queryKey: ["devices"],
    enabled: runsTheFleet,
    queryFn: async () => (await api.get<DevicePage>("/devices")).data,
  });

  if (attention.isError) {
    return <Failed onRetry={() => void attention.refetch()} />;
  }

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>

      {mayRead && waiting ? (
        <section className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
          <h2 className="text-sm font-medium">{t("attention")}</h2>
          {quiet ? (
            <p className="mt-2 text-sm text-(--color-ok)">{t("attentionClear")}</p>
          ) : (
            <div className="mt-3 grid gap-4 lg:grid-cols-3">
              {waiting.contractsEnding.length > 0 ? (
                <div>
                  <p className="text-xs font-medium text-(--color-warn) uppercase">
                    {t("contractsEnding")}
                  </p>
                  <p className="mt-0.5 text-xs text-(--color-muted)">{t("contractsHint")}</p>
                  <ul className="mt-2 flex flex-col gap-1 text-sm">
                    {waiting.contractsEnding.slice(0, 5).map((row) => (
                      <li key={row.contractId} className="flex justify-between gap-2">
                        <Link
                          href={`/employees/${row.employeeId}`}
                          className="truncate text-(--color-accent) hover:underline"
                        >
                          {row.fullName}
                        </Link>
                        <span className="shrink-0 tabular-nums">
                          {t("daysLeft", { count: row.daysLeft })}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {waiting.probationEnding.length > 0 ? (
                <div>
                  <p className="text-xs font-medium text-(--color-warn) uppercase">
                    {t("probationEnding")}
                  </p>
                  <p className="mt-0.5 text-xs text-(--color-muted)">{t("probationHint")}</p>
                  <ul className="mt-2 flex flex-col gap-1 text-sm">
                    {waiting.probationEnding.slice(0, 5).map((row) => (
                      <li key={row.contractId} className="flex justify-between gap-2">
                        <Link
                          href={`/employees/${row.employeeId}`}
                          className="truncate text-(--color-accent) hover:underline"
                        >
                          {row.fullName}
                        </Link>
                        <span className="shrink-0 tabular-nums">
                          {t("daysLeft", { count: row.daysLeft })}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {waiting.exceptionsToday.length > 0 ? (
                <div>
                  <p className="text-xs font-medium text-(--color-warn) uppercase">
                    {t("exceptionsToday")}
                  </p>
                  <ul className="mt-2 flex flex-col gap-1 text-sm">
                    {waiting.exceptionsToday.slice(0, 8).map((row) => (
                      <li key={row.employeeId} className="flex justify-between gap-2">
                        <Link
                          href={`/attendance/${row.employeeId}`}
                          className="truncate text-(--color-accent) hover:underline"
                        >
                          {row.fullName}
                        </Link>
                        <span className="shrink-0 text-(--color-muted)">
                          {t(REASON_KEY[row.reason])}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
        </section>
      ) : null}
      {runsTheFleet ? (
      <p className="mt-1 text-sm text-(--color-muted)">
        {devices.isPending
          ? common("loading")
          : t("deviceCount", { count: devices.data?.total ?? 0 })}
      </p>
      ) : null}

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

      {runsTheFleet ? (
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
      ) : null}
    </section>
  );
}
