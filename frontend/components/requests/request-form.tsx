"use client";

import { Banner, Checkbox, Input, LayerDialog, Select, Textarea } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { useNotify } from "@/components/ui/notify";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";
import { days } from "@/lib/format";
import { keep } from "@/lib/outbox";
import type { RequestKind } from "./request-card";

export const REQUEST_KINDS: RequestKind[] = ["LEAVE", "OVERTIME", "ATTENDANCE_FIX", "BUSINESS_TRIP", "REMOTE_WORK"];

const kFormId = "request-form";

interface LeaveType {
  id: string;
  code: string;
  name: string;
}

interface Balance {
  leaveTypeId: string;
  remaining: number;
}

/** The reader's calendar day, which is what a request's dates mean. */
export function todayHere(): string {
  const at = new Date();
  const pad = (one: number) => String(one).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
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
  const locale = useLocale();
  const faultOf = useFault();
  const notify = useNotify();
  const cache = useQueryClient();
  const [kind, setKind] = useState<RequestKind>(preset ?? "LEAVE");
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [fromDate, setFromDate] = useState(date ?? todayHere());
  const [toDate, setToDate] = useState(date ?? todayHere());
  const [halfDay, setHalfDay] = useState(false);
  const [minutes, setMinutes] = useState("");
  const [reason, setReason] = useState("");
  const [typeMissing, setTypeMissing] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const backwards = toDate < fromDate;

  const types = useQuery({
    queryKey: ["leave-types"],
    queryFn: async () => (await api.get<LeaveType[]>("/leave-types")).data,
  });

  const balances = useQuery({
    queryKey: ["leave-balances", todayHere()],
    enabled: open && kind === "LEAVE",
    queryFn: async () => (await api.get<Balance[]>(`/leave-balances?asOf=${todayHere()}`)).data,
  });

  const file = useMutation({
    mutationFn: async () => {
      const body = {
        kind,
        leaveTypeId: kind === "LEAVE" ? leaveTypeId : undefined,
        fromDate,
        toDate,
        halfDay: kind === "LEAVE" ? halfDay : undefined,
        minutes: minutes ? Number(minutes) : undefined,
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
      notify.done(queued ? t("queued") : t("filed"));
      void cache.invalidateQueries({ queryKey: ["requests"] });
      void cache.invalidateQueries({ queryKey: ["leave-balances"] });
      onOpenChange(false);
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setFault(null);
    if (kind === "LEAVE" && leaveTypeId === "") {
      setTypeMissing(true);
      return;
    }
    if (!backwards) {
      file.mutate();
    }
  }

  const left = balances.data?.find((one) => one.leaveTypeId === leaveTypeId);
  const wantsMinutes = kind === "OVERTIME" || kind === "ATTENDANCE_FIX";

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
            {kind === "LEAVE" ? (
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
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label={t("from")}
                type="date"
                required
                value={fromDate}
                onChange={(event) => setFromDate(event.target.value)}
              />
              <Input
                label={t("to")}
                type="date"
                required
                min={fromDate}
                value={toDate}
                variant={backwards ? "error" : "default"}
                error={backwards ? t("backwards") : undefined}
                onChange={(event) => setToDate(event.target.value)}
              />
            </div>
            {kind === "LEAVE" ? <Checkbox label={t("halfDay")} checked={halfDay} onCheckedChange={setHalfDay} /> : null}
            {wantsMinutes ? (
              <Input
                label={t("minutes")}
                type="number"
                inputMode="numeric"
                min={0}
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
              />
            ) : null}
            <Textarea
              label={t("reason")}
              required
              rows={3}
              maxLength={500}
              value={reason}
              onValueChange={setReason}
            />
            {fault ? <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null}
          </form>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel={common("cancel")}>
          <LayerDialog.Actions.Primary type="submit" form={kFormId} loading={file.isPending} disabled={backwards}>
            {t("submit")}
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}
