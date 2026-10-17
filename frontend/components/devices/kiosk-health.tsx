"use client";

import { LayerCard } from "@cloudflare/kumo";
import { HeartbeatIcon } from "@phosphor-icons/react";
import { useFormatter, useNow, useTranslations } from "next-intl";

import { Facts } from "@/components/ui/page";
import { StatePill } from "@/components/ui/pill";
import { stampOptions } from "@/lib/format";

/** What the last live heartbeat said about a kiosk, and the ticket it holds (KEHOACH 4.8, 7.3). */
export interface KioskHealthFacts {
  bootedAt: string | null;
  rssiDbm: number | null;
  heapFreeBytes: number | null;
  heapMinFreeBytes: number | null;
  psramFreeBytes: number | null;
  pendingUplinkCount: number | null;
  activeSlot: 0 | 1 | null;
  bootCount: number | null;
  healthAt: string | null;
  tokenIssuedAt: string | null;
  tokenExpiresAt: string | null;
}

const kMinuteMs = 60_000;
const kKiB = 1024;
const kMiB = 1024 * 1024;

/** The Kiosk health card of one kiosk page: the answer a Diagnostics press waits for. */
export function KioskHealth({ it, online }: { it: KioskHealthFacts; online: boolean }) {
  const t = useTranslations("devices");
  const common = useTranslations("common");
  const format = useFormatter();
  const now = useNow({ updateInterval: kMinuteMs });

  const size = (bytes: number | null): string => {
    if (bytes === null) {
      return common("empty");
    }
    const [unit, per] = bytes >= kMiB ? (["megabyte", kMiB] as const) : (["kilobyte", kKiB] as const);
    return format.number(bytes / per, { style: "unit", unit, maximumFractionDigits: 1 });
  };
  const stamp = (at: string) => format.dateTime(new Date(at), stampOptions(at));
  const heard = it.healthAt ? new Date(it.healthAt) : null;
  const pending = it.pendingUplinkCount;

  const ticket = it.tokenIssuedAt && it.tokenExpiresAt
    ? t("healthTicketValue", { issued: stamp(it.tokenIssuedAt), expires: format.dateTime(new Date(it.tokenExpiresAt), "day") })
    : t("healthTicketNone");

  return (
    <LayerCard>
      <LayerCard.Secondary className="justify-between">
        <span>{t("healthTitle")}</span>
        {heard ? (
          <span className="text-sm font-normal text-kumo-subtle tabular-nums">
            {t("healthAt", { time: format.dateTime(heard, { ...stampOptions(heard), second: "2-digit" }) })}
          </span>
        ) : null}
      </LayerCard.Secondary>
      <LayerCard.Primary className="@container/health flex flex-col gap-3">
        {heard ? (
          <div className="grid gap-y-2 @lg/health:grid-cols-2 @lg/health:gap-x-8 @lg/health:gap-y-0 @max-lg/health:[&>dl:first-child>div:last-child]:border-b">
            <Facts
              rows={[
                [t("healthSignal"), it.rssiDbm === null ? common("empty") : t("healthSignalValue", { dbm: it.rssiDbm })],
                [
                  t("healthBooted"),
                  it.bootedAt
                    ? [format.relativeTime(new Date(it.bootedAt), now), it.bootCount === null ? null : t("healthBootCount", { count: it.bootCount })]
                        .filter(Boolean)
                        .join(" · ")
                    : common("empty"),
                ],
                [t("healthSlot"), it.activeSlot === null ? common("empty") : t("healthSlotValue", { slot: it.activeSlot })],
                [
                  t("healthPending"),
                  pending === null ? (
                    common("empty")
                  ) : pending > 0 ? (
                    <StatePill key="p" tone="waiting">
                      {t("healthPendingValue", { count: pending })}
                    </StatePill>
                  ) : (
                    t("healthPendingValue", { count: pending })
                  ),
                ],
              ]}
            />
            <Facts
              rows={[
                [t("healthHeap"), size(it.heapFreeBytes)],
                [t("healthHeapMin"), size(it.heapMinFreeBytes)],
                [t("healthPsram"), size(it.psramFreeBytes)],
                [t("healthTicket"), ticket],
              ]}
            />
          </div>
        ) : (
          <>
            <p className="flex items-center gap-2 text-pretty text-kumo-subtle">
              <HeartbeatIcon size={16} className="shrink-0" aria-hidden />
              {online ? t("healthNone") : t("healthNoneOffline")}
            </p>
            <Facts rows={[[t("healthTicket"), ticket]]} />
          </>
        )}
      </LayerCard.Primary>
    </LayerCard>
  );
}
