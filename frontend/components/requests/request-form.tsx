"use client";

import { Banner, Checkbox, Input, LayerDialog, Radio, Select, Textarea } from "@cloudflare/kumo";
import { InfoIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { DateField } from "@/components/ui/date-field";
import { useNotify } from "@/components/ui/notify";
import { SkeletonLine } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { addDays, atClock, dayOnly, dayWindow, days, minutes as minutesOf, todayIso } from "@/lib/format";
import { keep } from "@/lib/outbox";
import type { DayPart, RequestKind } from "./request-card";

export const REQUEST_KINDS: RequestKind[] = ["LEAVE", "OVERTIME", "ATTENDANCE_FIX", "BUSINESS_TRIP", "REMOTE_WORK"];

const kFormId = "request-form";
const kReasonMax = 500;
const kDayMs = 86_400_000;
const kMinuteMs = 60_000;

type Missed = "IN" | "OUT" | "BOTH";

interface LeaveType {
  id: string;
  code: string;
  name: string;
}

interface Balance {
  leaveTypeId: string;
  remaining: number;
}

/** What the server would charge for the range, per calendar year (KEHOACH 9.5). */
interface LeaveDays {
  days: number;
  limited: boolean;
  calendarDays: boolean;
  parts: { year: number; days: number; left: number | null }[];
}

interface Punch {
  ts: string;
}

/** A company date and a company wall-clock time as one instant, or null until both are there. */
function instant(day: string, time: string): Date | null {
  if (!day || !time) {
    return null;
  }
  const at = atClock(day, time);
  return Number.isNaN(at.getTime()) ? null : at;
}

function spanDays(from: string, to: string): number {
  return Math.round((dayOnly(to).getTime() - dayOnly(from).getTime()) / kDayMs) + 1;
}

export function isRequestKind(value: string | null): value is RequestKind {
  return value !== null && (REQUEST_KINDS as string[]).includes(value);
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Mount a fresh form per opening (a new `key`) so a preset lands in empty fields. */
  kind?: RequestKind;
  date?: string;
}

/** File a request in a dialog; with no signal it is kept on the device and sent later (KEHOACH 9.21.3). */
export function RequestForm({ open, onOpenChange, kind: preset, date }: Props) {
  const t = useTranslations("requests");
  const common = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();
  const faultOf = useFault();
  const notify = useNotify();
  const cache = useQueryClient();
  const employeeId = useSession((s) => s.employeeId);
  const [kind, setKind] = useState<RequestKind>(preset ?? "LEAVE");
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [fromDate, setFromDate] = useState(date ?? (preset === "ATTENDANCE_FIX" ? addDays(todayIso(), -1) : todayIso()));
  const [toDate, setToDate] = useState(date ?? todayIso());
  const [halfDay, setHalfDay] = useState(false);
  const [dayPart, setDayPart] = useState<DayPart>("MORNING");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [missed, setMissed] = useState<Missed>("OUT");
  const [reason, setReason] = useState("");
  const [typeMissing, setTypeMissing] = useState(false);
  const [fault, setFault] = useState<string | null>(null);

  const oneDay = kind === "OVERTIME" || kind === "ATTENDANCE_FIX";
  const lastDay = oneDay ? fromDate : toDate;
  const backwards = !oneDay && toDate < fromDate;
  const half = kind === "LEAVE" && halfDay && fromDate === toDate;

  const types = useQuery({
    queryKey: ["leave-types"],
    enabled: open,
    queryFn: async () => (await api.get<LeaveType[]>("/leave-types")).data,
  });

  const balances = useQuery({
    queryKey: ["leave-balances", "mine", fromDate.slice(0, 4), fromDate],
    enabled: open && kind === "LEAVE" && fromDate !== "",
    queryFn: async () => (await api.get<Balance[]>(`/leave-balances?asOf=${fromDate}`)).data,
  });

  // Under the balances key, so a filing or a new year refreshes it with them.
  const charge = useQuery({
    queryKey: ["leave-balances", "days", fromDate, toDate, half, leaveTypeId],
    enabled: open && kind === "LEAVE" && fromDate !== "" && toDate !== "" && toDate >= fromDate,
    retry: false,
    queryFn: async () => {
      const query = new URLSearchParams({ fromDate, toDate, halfDay: String(half) });
      if (leaveTypeId !== "") {
        query.set("leaveTypeId", leaveTypeId);
      }
      return (await api.get<LeaveDays>(`/leave-days?${query.toString()}`)).data;
    },
  });
  // Only an answer refuses the range; no answer at all is offline, where the filing still queues.
  const refused = kind === "LEAVE" && isAxiosError(charge.error) && charge.error.response !== undefined;
  const noTypes = types.isSuccess && types.data.length === 0;

  // The other end of the day comes from what the kiosk saw, so one claimed punch is enough.
  const punches = useQuery({
    queryKey: ["attendance", "day", employeeId, fromDate],
    enabled: open && kind === "ATTENDANCE_FIX" && employeeId !== null && fromDate !== "",
    queryFn: async () => {
      const { from, to } = dayWindow(fromDate);
      const query = new URLSearchParams({ employeeId: String(employeeId), from: from.toISOString(), to: to.toISOString(), take: "50" });
      return (await api.get<{ rows: Punch[] }>(`/attendance?${query.toString()}`)).data.rows;
    },
  });
  const seen = (punches.data ?? []).map((one) => new Date(one.ts).getTime()).sort((left, right) => left - right);
  const firstSeen = seen.length > 0 ? new Date(seen[0] as number) : null;
  const lastSeen = seen.length > 0 ? new Date(seen[seen.length - 1] as number) : null;
  const claimed: Missed = seen.length === 0 ? "BOTH" : missed;

  const startAt = instant(fromDate, startTime);
  const endAt = instant(fromDate, endTime);
  const fixIn = kind === "ATTENDANCE_FIX" && claimed !== "OUT" ? startAt : null;
  const fixOut = kind === "ATTENDANCE_FIX" && claimed !== "IN" ? endAt : null;
  const worked =
    kind === "OVERTIME"
      ? startAt && endAt
        ? (endAt.getTime() - startAt.getTime()) / kMinuteMs
        : null
      : kind === "ATTENDANCE_FIX"
        ? (() => {
            const from = fixIn ?? firstSeen;
            const to = fixOut ?? lastSeen;
            return from && to ? (to.getTime() - from.getTime()) / kMinuteMs : null;
          })()
        : null;
  const timesBackwards = worked !== null && worked <= 0;
  const count = half ? 0.5 : backwards ? 0 : spanDays(fromDate, lastDay);
  const left = balances.data?.find((one) => one.leaveTypeId === leaveTypeId);

  const file = useMutation({
    mutationFn: async () => {
      const body = {
        kind,
        leaveTypeId: kind === "LEAVE" ? leaveTypeId : undefined,
        fromDate,
        toDate: lastDay,
        halfDay: kind === "LEAVE" ? half : undefined,
        dayPart: half ? dayPart : undefined,
        fromAt: kind === "OVERTIME" ? startAt?.toISOString() : fixIn?.toISOString(),
        toAt: kind === "OVERTIME" ? endAt?.toISOString() : fixOut?.toISOString(),
        minutes: worked !== null && worked > 0 ? Math.round(worked) : undefined,
        reason,
      };
      const clientKey = crypto.randomUUID();
      try {
        await api.post("/requests", { ...body, clientKey });
        return { queued: false };
      } catch (fell) {
        // No response at all means nobody refused it, so it waits rather than being lost.
        if ((fell as { response?: unknown }).response !== undefined) {
          throw fell;
        }
        await keep({ clientKey, path: "/requests", body, filedAt: Date.now() });
        return { queued: true };
      }
    },
    onSuccess: ({ queued }) => {
      notify.done(queued ? t("queued") : t("filedDone"));
      void cache.invalidateQueries({ queryKey: ["requests"] });
      void cache.invalidateQueries({ queryKey: ["leave-balances"] });
      onOpenChange(false);
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const timesNeeded = (kind === "OVERTIME" || kind === "ATTENDANCE_FIX") && worked === null;
  const blocked = backwards || timesBackwards || (kind === "LEAVE" && (refused || noTypes));

  function submit(event: FormEvent) {
    event.preventDefault();
    setFault(null);
    if (kind === "LEAVE" && leaveTypeId === "") {
      setTypeMissing(true);
      return;
    }
    if (!blocked && !timesNeeded) {
      file.mutate();
    }
  }

  const clock = (at: Date) => format.dateTime(at, { hour: "2-digit", minute: "2-digit" });
  const summary =
    kind === "LEAVE"
      ? null
      : (kind === "BUSINESS_TRIP" || kind === "REMOTE_WORK") && !backwards
        ? t("summaryDays", { days: days(count, locale) })
        : worked !== null && worked > 0
          ? t("summaryMinutes", { length: minutesOf(Math.round(worked), locale) })
          : null;

  return (
    <LayerDialog.Root open={open} onOpenChange={onOpenChange} dismissDisabled={file.isPending}>
      <LayerDialog.Content closeLabel={common("close")}>
        <LayerDialog.Title>{t("newTitle")}</LayerDialog.Title>
        <LayerDialog.Description>{t("newLead")}</LayerDialog.Description>
        <LayerDialog.Body>
          <form id={kFormId} onSubmit={submit} className="flex flex-col gap-4">
            <Select
              label={t("kind")}
              hideLabel={false}
              className="w-full"
              value={kind}
              onValueChange={(next) => setKind(String(next ?? "LEAVE") as RequestKind)}
              items={Object.fromEntries(REQUEST_KINDS.map((one) => [one, t(`kind${one}`)]))}
            />
            {kind === "LEAVE" && noTypes ? (
              <Banner
                variant="alert"
                size="sm"
                icon={<InfoIcon weight="fill" />}
                title={t("noLeaveTypesTitle")}
                description={t("noLeaveTypesLead")}
              />
            ) : kind === "LEAVE" ? (
              <Select
                label={t("leaveType")}
                hideLabel={false}
                className="w-full"
                placeholder={t("leaveTypePick")}
                loading={types.isPending}
                value={leaveTypeId}
                onValueChange={(next) => {
                  setLeaveTypeId(String(next ?? ""));
                  setTypeMissing(false);
                }}
                items={Object.fromEntries((types.data ?? []).map((one) => [one.id, one.name]))}
                error={typeMissing ? common("required") : undefined}
                description={left ? t("balanceLeftOf", { left: days(left.remaining, locale) }) : undefined}
              />
            ) : null}
            {oneDay ? (
              <DateField
                label={t("day")}
                value={fromDate}
                max={kind === "ATTENDANCE_FIX" ? addDays(todayIso(), -1) : undefined}
                description={kind === "ATTENDANCE_FIX" ? t("fixDayHint") : undefined}
                onChange={setFromDate}
              />
            ) : (
              <div className="grid items-start gap-4 sm:grid-cols-2">
                <DateField label={t("from")} value={fromDate} onChange={setFromDate} />
                <DateField
                  label={t("to")}
                  value={toDate}
                  min={fromDate}
                  error={backwards ? t("backwards") : refused ? faultOf(charge.error) : undefined}
                  onChange={setToDate}
                />
              </div>
            )}
            {kind === "LEAVE" && fromDate === toDate ? (
              <Checkbox label={t("halfDay")} checked={halfDay} onCheckedChange={setHalfDay} />
            ) : null}
            {half ? (
              <Radio.Group legend={t("dayPart")} value={dayPart} onValueChange={(next) => setDayPart(next as DayPart)}>
                <Radio.Item value="MORNING" label={t("dayPartMORNING")} />
                <Radio.Item value="AFTERNOON" label={t("dayPartAFTERNOON")} />
              </Radio.Group>
            ) : null}
            {kind === "ATTENDANCE_FIX" ? (
              <>
                <p className="text-sm text-kumo-subtle">
                  {firstSeen && lastSeen
                    ? t("fixSeen", { first: clock(firstSeen), last: clock(lastSeen) })
                    : punches.isPending
                      ? t("fixLooking")
                      : t("fixNone")}
                </p>
                {seen.length > 0 ? (
                  <Radio.Group legend={t("fixMissed")} value={missed} onValueChange={(next) => setMissed(next as Missed)}>
                    <Radio.Item value="OUT" label={t("fixMissedOUT")} />
                    <Radio.Item value="IN" label={t("fixMissedIN")} />
                    <Radio.Item value="BOTH" label={t("fixMissedBOTH")} />
                  </Radio.Group>
                ) : null}
              </>
            ) : null}
            {kind === "OVERTIME" || kind === "ATTENDANCE_FIX" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {kind === "OVERTIME" || claimed !== "OUT" ? (
                  <Input
                    label={kind === "OVERTIME" ? t("startTime") : t("fixInTime")}
                    type="time"
                    required
                    value={startTime}
                    onChange={(event) => setStartTime(event.target.value)}
                  />
                ) : null}
                {kind === "OVERTIME" || claimed !== "IN" ? (
                  <Input
                    label={kind === "OVERTIME" ? t("endTime") : t("fixOutTime")}
                    type="time"
                    required
                    value={endTime}
                    error={timesBackwards ? t("timesBackwards") : undefined}
                    onChange={(event) => setEndTime(event.target.value)}
                  />
                ) : null}
              </div>
            ) : null}
            <Textarea
              label={t("reason")}
              required
              rows={3}
              maxLength={kReasonMax}
              value={reason}
              onValueChange={setReason}
            />
            {kind === "LEAVE" && !noTypes && !backwards && !refused ? <Charged asked={charge} /> : null}
            {summary ? <p className="rounded-lg bg-kumo-tint px-3 py-2 tabular-nums">{summary}</p> : null}
            {fault ? <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null}
          </form>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel={common("cancel")}>
          <LayerDialog.Actions.Primary type="submit" form={kFormId} loading={file.isPending} disabled={blocked}>
            {t("submit")}
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

/** The working days the server would take, split by year when the range crosses one. */
function Charged({ asked }: { asked: { data?: LeaveDays; isPending: boolean; isError: boolean } }) {
  const t = useTranslations("requests");
  const locale = useLocale();
  if (asked.isError) {
    return null;
  }
  const shown = asked.data;
  const split = shown !== undefined && shown.parts.length > 1;
  const only = shown?.parts[0];
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-kumo-tint px-3 py-2 tabular-nums">
      {shown === undefined ? (
        <SkeletonLine minWidth={40} maxWidth={60} />
      ) : !shown.limited ? (
        <p>{t("summaryUnpaid", { days: days(shown.days, locale) })}</p>
      ) : split ? (
        <>
          <p className="font-medium">{t("charged", { days: days(shown.days, locale) })}</p>
          <p className="text-sm text-kumo-subtle">{t("splitByYear")}</p>
          <ul className="flex flex-col">
            {shown.parts.map((part) => (
              <li key={part.year}>
                {part.left === null
                  ? t("yearDays", { year: part.year, days: days(part.days, locale) })
                  : t("chargedYear", { year: part.year, days: days(part.days, locale), left: days(part.left, locale) })}
              </li>
            ))}
          </ul>
        </>
      ) : only && only.left !== null ? (
        <p>{t("summaryLeave", { days: days(shown.days, locale), left: days(only.left, locale) })}</p>
      ) : (
        <p>{t("charged", { days: days(shown.days, locale) })}</p>
      )}
      {shown ? <p className="text-sm text-kumo-subtle">{t(shown.calendarDays ? "calendarDaysAll" : "workingDaysOnly")}</p> : null}
    </div>
  );
}
