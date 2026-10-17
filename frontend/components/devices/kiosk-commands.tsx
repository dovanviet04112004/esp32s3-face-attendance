"use client";

import { Banner, Button, Input, LayerCard, LayerDialog, Select } from "@cloudflare/kumo";
import type { Icon } from "@phosphor-icons/react";
import {
  ArrowCounterClockwiseIcon,
  ClockClockwiseIcon,
  DoorOpenIcon,
  KeyIcon,
  SlidersHorizontalIcon,
  StethoscopeIcon,
  TerminalWindowIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { useNotify } from "@/components/ui/notify";
import { useOptional } from "@/components/ui/optional";
import { StatePill, type Tone } from "@/components/ui/pill";
import { SkeletonLine } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { stampOptions } from "@/lib/format";
import { useFeed } from "@/lib/ws";
import { deviceCmdSchema, type DeviceCommand } from "@/types/generated/device_cmd";

type Action = DeviceCommand["action"];
type CommandState = "QUEUED" | "SENT" | "DONE" | "REJECTED" | "EXPIRED";

interface CommandRow {
  cmdId: string;
  action: Action;
  state: CommandState;
  resultNote: string | null;
  issuedBy: string | null;
  expiresAt: string | null;
  createdAt: string;
}

const STATE_TONE: Record<CommandState, Tone> = { QUEUED: "waiting", SENT: "waiting", DONE: "good", REJECTED: "bad", EXPIRED: "idle" };
const QUICK: { action: Action; icon: Icon }[] = [
  { action: "OPEN_DOOR", icon: DoorOpenIcon },
  { action: "SYNC_TIME", icon: ClockClockwiseIcon },
  { action: "DIAGNOSTICS", icon: StethoscopeIcon },
  { action: "ROTATE_TOKEN", icon: KeyIcon },
];
const ANSWERS: ReadonlySet<unknown> = new Set(["COMMAND_DONE", "COMMAND_REJECTED"]);
// The ranges are the contract's, the same the server checks a command against (KEHOACH 4.6).
const SETTINGS = deviceCmdSchema.shape.config.unwrap().shape;
const NUMBERS = ["brightness", "volume", "dedupWindowMinutes", "faceMinPx", "wakeDistanceCm"] as const;
type NumberField = (typeof NUMBERS)[number];
type Draft = Record<NumberField, string> & { lang: "" | "vi" | "en" };
const BLANK: Draft = { brightness: "", volume: "", dedupWindowMinutes: "", faceMinPx: "", wakeDistanceCm: "", lang: "" };

function rangeOf(field: NumberField): { min: number; max: number } {
  const inner = SETTINGS[field].unwrap();
  return { min: inner.minValue ?? 0, max: inner.maxValue ?? 0 };
}

function outside(field: NumberField, typed: string): boolean {
  if (typed.trim() === "") {
    return false;
  }
  const value = Number(typed);
  const { min, max } = rangeOf(field);
  return !Number.isInteger(value) || value < min || value > max;
}

/** The Commands card of one kiosk: what an ADMIN can ask it now, and how the recent asks ended (KEHOACH 4.6). */
export function KioskCommands({ deviceId, name, online }: { deviceId: string; name: string; online: boolean }) {
  const t = useTranslations("devices");
  const common = useTranslations("common");
  const format = useFormatter();
  const notify = useNotify();
  const optional = useOptional();
  const cache = useQueryClient();
  const { items } = useFeed();
  const [restarting, setRestarting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const key = ["devices", deviceId, "commands"];

  const recent = useQuery({
    queryKey: key,
    queryFn: async () => (await api.get<CommandRow[]>(`/devices/${deviceId}/commands`)).data,
  });

  // The kiosk's answer reaches the feed first, and an unanswered command lapses at its deadline.
  const heard = items.find((item) => item.feed === "event" && item.body.deviceId === deviceId && ANSWERS.has(item.body.type))?.id;
  useEffect(() => {
    if (heard) {
      void cache.invalidateQueries({ queryKey: ["devices", deviceId, "commands"] });
    }
  }, [heard, cache, deviceId]);
  const nextDeadline = (recent.data ?? [])
    .filter((row) => (row.state === "SENT" || row.state === "QUEUED") && row.expiresAt)
    .map((row) => Date.parse(row.expiresAt as string))
    .sort((a, b) => a - b)[0];
  useEffect(() => {
    if (nextDeadline === undefined) {
      return;
    }
    const timer = setTimeout(
      () => void cache.invalidateQueries({ queryKey: ["devices", deviceId, "commands"] }),
      Math.max(0, nextDeadline - Date.now()) + 500,
    );
    return () => clearTimeout(timer);
  }, [nextDeadline, cache, deviceId]);

  const send = useMutation({
    mutationFn: async (body: Pick<DeviceCommand, "action" | "config">) =>
      (await api.post<CommandRow>(`/devices/${deviceId}/commands`, body)).data,
    onSuccess: (row) => {
      setRestarting(false);
      setEditing(false);
      notify.done(t("commandSent", { action: t(`command_${row.action}`) }));
      void cache.invalidateQueries({ queryKey: ["devices", deviceId, "commands"] });
    },
    onError: (fell: unknown) => {
      setRestarting(false);
      notify.failed(fell);
    },
  });

  const wrong = NUMBERS.filter((field) => outside(field, draft[field]));
  const filled = NUMBERS.some((field) => draft[field].trim() !== "") || draft.lang !== "";
  function sendSettings(): void {
    const config: NonNullable<DeviceCommand["config"]> = {};
    for (const field of NUMBERS) {
      if (draft[field].trim() !== "") {
        config[field] = Number(draft[field]);
      }
    }
    if (draft.lang !== "") {
      config.lang = draft.lang;
    }
    send.mutate({ action: "SET_CONFIG", config });
  }

  const pressing = (action: Action) => send.isPending && send.variables?.action === action;
  const rows = recent.data ?? [];

  return (
    <LayerCard>
      <LayerCard.Secondary>{t("commandsTitle")}</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-4">
        <p className="text-pretty text-kumo-subtle">{online ? t("commandsLead") : t("commandsOffline")}</p>
        <div className="flex flex-wrap gap-2">
          {QUICK.map(({ action, icon }) => (
            <Button
              key={action}
              variant="secondary"
              icon={icon}
              loading={pressing(action)}
              disabled={!online || send.isPending}
              onClick={() => send.mutate({ action })}
            >
              {t(`command_${action}`)}
            </Button>
          ))}
          <Button
            variant="secondary"
            icon={SlidersHorizontalIcon}
            disabled={!online || send.isPending}
            onClick={() => {
              setDraft(BLANK);
              setEditing(true);
            }}
          >
            {t("command_SET_CONFIG")}
          </Button>
          <Button
            variant="secondary-destructive"
            icon={ArrowCounterClockwiseIcon}
            disabled={!online || send.isPending}
            onClick={() => setRestarting(true)}
          >
            {t("command_REBOOT")}
          </Button>
        </div>

        {recent.isPending ? (
          <div className="flex flex-col gap-3">
            <SkeletonLine minWidth={40} maxWidth={60} />
            <SkeletonLine minWidth={30} maxWidth={50} />
          </div>
        ) : recent.isError ? (
          <Banner variant="error" description={t("commandsFailed")} />
        ) : rows.length === 0 ? (
          <p className="flex items-center gap-2 text-kumo-subtle">
            <TerminalWindowIcon size={16} aria-hidden />
            {t("commandsEmpty")}
          </p>
        ) : (
          <ul className="-my-1 flex flex-col">
            {rows.map((row) => {
              const at = new Date(row.createdAt);
              return (
                <li key={row.cmdId} className="flex items-start gap-3 border-b border-kumo-hairline py-2 last:border-0">
                  <span className="min-w-11 shrink-0 pt-0.5 text-sm whitespace-nowrap text-kumo-subtle tabular-nums">
                    {format.dateTime(at, stampOptions(at))}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{t(`command_${row.action}`)}</span>
                    <span className="truncate text-sm text-kumo-subtle">
                      {[row.resultNote, row.issuedBy].filter(Boolean).join(" · ") || common("empty")}
                    </span>
                  </span>
                  <StatePill tone={STATE_TONE[row.state]}>{t(`commandState_${row.state}`)}</StatePill>
                </li>
              );
            })}
          </ul>
        )}
      </LayerCard.Primary>

      <LayerDialog.Alert open={restarting} onOpenChange={setRestarting} dismissDisabled={send.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("rebootTitle", { name })}</LayerDialog.Title>
          <LayerDialog.Description>{t("rebootWarn")}</LayerDialog.Description>
          <LayerDialog.Body>
            <p className="font-mono text-sm text-kumo-subtle">{deviceId}</p>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary variant="destructive" loading={pressing("REBOOT")} onClick={() => send.mutate({ action: "REBOOT" })}>
              {t("command_REBOOT")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>

      <LayerDialog.Root open={editing} onOpenChange={setEditing} dismissDisabled={send.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("configTitle", { name })}</LayerDialog.Title>
          <LayerDialog.Description>{t("configLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              {NUMBERS.map((field) => {
                const { min, max } = rangeOf(field);
                return (
                  <Input
                    key={field}
                    label={optional(t(`config_${field}`))}
                    type="number"
                    inputMode="numeric"
                    min={min}
                    max={max}
                    step={1}
                    value={draft[field]}
                    description={t("configRange", { min, max })}
                    error={wrong.includes(field) ? t("configOutOfRange", { min, max }) : undefined}
                    onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
                  />
                );
              })}
              <Select
                label={optional(t("config_lang"))}
                className="w-full"
                value={draft.lang}
                onValueChange={(next) => setDraft({ ...draft, lang: String(next ?? "") as Draft["lang"] })}
                items={{ "": t("configKeep"), vi: t("lang_vi"), en: t("lang_en") }}
              />
              <Banner variant="alert" icon={<WarningIcon weight="fill" />} description={t("configModelThresholds")} className="text-pretty" />
            </div>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary loading={pressing("SET_CONFIG")} disabled={!filled || wrong.length > 0} onClick={sendSettings}>
              {t("configSend")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </LayerCard>
  );
}
