"use client";

import { Banner, Input, LayerDialog } from "@cloudflare/kumo";
import { CalendarXIcon, WarningCircleIcon, WarningIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { DateField } from "@/components/ui/date-field";
import { useNotify } from "@/components/ui/notify";
import { useOptional } from "@/components/ui/optional";
import { StatePill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";
import { addDays, dayOnly, todayIso } from "@/lib/format";

export interface Offboarding {
  employeeId: number;
  code: string;
  leaveDate: string;
  closed: boolean;
  assetsOutstanding: { code: string; name: string }[];
  requestsPending: number;
  advancesOutstanding: number;
}

export function isOutstanding(left: Offboarding): boolean {
  return left.assetsOutstanding.length > 0 || left.requestsPending > 0 || left.advancesOutstanding > 0;
}

/** A person still working whose last day is set: "Leaving 27/9", with the year only when it is not this one. */
export function LeavingPill({ leaveDate }: { leaveDate: string }) {
  const t = useTranslations("employees");
  const format = useFormatter();
  const day = dayOnly(leaveDate);
  const sameYear = leaveDate.slice(0, 4) === todayIso().slice(0, 4);
  const shown = format.dateTime(day, { day: "numeric", month: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
  return <StatePill tone="waiting">{t("statusLeaving", { day: shown })}</StatePill>;
}

/** What a scheduled leaving does and when, above whatever tab of the profile is open. */
export function LeavingBanner({ leaveDate, actions }: { leaveDate: string; actions?: ReactNode }) {
  const t = useTranslations("employees");
  const format = useFormatter();
  const dayText = (day: string) => format.dateTime(dayOnly(day), "day");
  return (
    <Banner
      icon={<CalendarXIcon weight="fill" />}
      title={t("leavingTitle", { day: dayText(leaveDate) })}
      description={
        <>
          {t("leavingLead", { next: dayText(addDays(leaveDate, 1)) })}
          {actions ? <span className="mt-2 flex flex-wrap gap-2">{actions}</span> : null}
        </>
      }
    />
  );
}

function refreshAfterLeaving(cache: QueryClient, employeeId: number): void {
  void cache.invalidateQueries({ queryKey: ["employees"] });
  void cache.invalidateQueries({ queryKey: ["users"] });
  void cache.invalidateQueries({ queryKey: ["assets"] });
  void cache.invalidateQueries({ queryKey: ["enrollments", "employee", employeeId] });
  void cache.invalidateQueries({ queryKey: ["biometric-consents", employeeId] });
  void cache.invalidateQueries({ queryKey: ["reports", "attention"] });
}

/** What a leaver still holds or has pending, shown once the offboarding is written. */
export function Outstanding({ left, action }: { left: Offboarding; action?: ReactNode }) {
  const t = useTranslations("employees");
  const format = useFormatter();
  const day = format.dateTime(dayOnly(left.leaveDate), "day");
  return (
    <Banner
      variant="alert"
      icon={<WarningIcon weight="fill" />}
      title={left.closed ? t("offboardLeftover", { day }) : t("offboardLeftoverAhead", { day })}
      description={
        <ul className="mt-1 flex list-disc flex-col gap-0.5 ps-5">
          {left.assetsOutstanding.length > 0 ? (
            <li>
              {t("offboardAssets", { count: left.assetsOutstanding.length })}:{" "}
              <span className="font-mono">{left.assetsOutstanding.map((one) => one.code).join(", ")}</span>
            </li>
          ) : null}
          {left.requestsPending > 0 ? <li>{t("offboardRequests", { count: left.requestsPending })}</li> : null}
          {left.advancesOutstanding > 0 ? <li>{t("offboardAdvances", { count: left.advancesOutstanding })}</li> : null}
        </ul>
      }
      action={action}
    />
  );
}

/** Calls off a scheduled leaving; the record stays open and the person keeps working. */
export function useCancelLeaving(employeeId: number, fullName: string) {
  const t = useTranslations("employees");
  const cache = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: () => api.delete(`/employees/${employeeId}/offboard`),
    onSuccess: () => {
      notify.done(t("offboardCancelled", { name: fullName }));
      refreshAfterLeaving(cache, employeeId);
    },
    onError: notify.failed,
  });
}

/**
 * Records a last day, or moves the one scheduled, saying what the chosen day does: today or
 * earlier closes the record now, a later day only schedules it (KEHOACH 9.14).
 */
export function Offboard({
  employeeId,
  fullName,
  scheduled,
  open,
  onOpenChange,
  onDone,
}: {
  employeeId: number;
  fullName: string;
  scheduled: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (left: Offboarding) => void;
}) {
  const t = useTranslations("employees");
  const format = useFormatter();
  const common = useTranslations("common");
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();
  const optional = useOptional();
  const moving = scheduled !== null;
  const startDay = () => (scheduled ? scheduled.slice(0, 10) : todayIso());

  const [fault, setFault] = useState<string | null>(null);
  const [leaveDate, setLeaveDate] = useState(startDay);
  const [reason, setReason] = useState("");

  const closesNow = leaveDate !== "" && leaveDate <= todayIso();
  const dayText = (day: string) => format.dateTime(dayOnly(day), "day");

  function close(): void {
    setFault(null);
    setLeaveDate(startDay());
    setReason("");
    onOpenChange(false);
  }

  const leave = useMutation({
    mutationFn: async () =>
      moving
        ? (await api.patch<Offboarding>(`/employees/${employeeId}/offboard`, { leaveDate })).data
        : (await api.post<Offboarding>(`/employees/${employeeId}/offboard`, { leaveDate, reason: reason || undefined })).data,
    onSuccess: (left) => {
      close();
      const day = dayText(left.leaveDate);
      if (left.closed) {
        notify.done(t("offboardDone", { day }));
      } else {
        notify.done(moving ? t("offboardMoved", { day }) : t("offboardScheduled", { name: fullName, day }));
      }
      onDone(left);
      refreshAfterLeaving(cache, employeeId);
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const lead = closesNow
    ? t("offboardNowLead")
    : t("offboardLaterLead", { name: fullName, day: dayText(leaveDate), next: dayText(addDays(leaveDate, 1)) });
  const act = closesNow ? t("offboardActionNow") : moving ? t("offboardMoveAction") : t("offboardActionLater");

  return (
    <LayerDialog.Alert
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      dismissDisabled={leave.isPending}
    >
      <LayerDialog.Content closeLabel={common("close")}>
        <LayerDialog.Title>
          {moving ? t("offboardMoveTitle", { name: fullName }) : t("offboardTitleOf", { name: fullName })}
        </LayerDialog.Title>
        <LayerDialog.Description>{leaveDate ? lead : t("offboardDay")}</LayerDialog.Description>
        <LayerDialog.Body>
          <form
            id="offboard"
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              setFault(null);
              leave.mutate();
            }}
          >
            <DateField label={t("offboardDay")} required value={leaveDate} onChange={setLeaveDate} />
            {moving ? null : (
              <Input
                label={optional(t("offboardReason"))}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </form>
          {fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} className="mt-4" /> : null}
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel={common("cancel")}>
          <LayerDialog.Actions.Primary
            type="submit"
            form="offboard"
            variant={closesNow ? "destructive" : "primary"}
            disabled={leaveDate === ""}
            loading={leave.isPending}
          >
            {act}
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Alert>
  );
}
