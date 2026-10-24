"use client";

import { Banner, Button, Input, LayerCard, LayerDialog, Select } from "@cloudflare/kumo";
import type { Icon } from "@phosphor-icons/react";
import {
  ArrowCounterClockwiseIcon,
  ClockClockwiseIcon,
  DoorOpenIcon,
  InfoIcon,
  KeyIcon,
  SlidersHorizontalIcon,
  StethoscopeIcon,
  SwapIcon,
  TerminalWindowIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { PagingRow } from "@/components/tables/data-table";
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
type Slot = NonNullable<DeviceCommand["activeSlot"]>;

interface CommandRow {
  cmdId: string;
  action: Action;
  state: CommandState;
  resultNote: string | null;
  issuedBy: string | null;
  expiresAt: string | null;
  createdAt: string;
}

interface CommandPage {
  rows: CommandRow[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
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

type NoteKey =
  | "note_doorHeld"
  | "note_sntp"
  | "note_heartbeat"
  | "note_renewal"
  | "note_noTicket"
  | "note_rebooting"
  | "note_config"
  | "note_configRange"
  | "note_slotRunning"
  | "note_slotEmpty"
  | "note_slotTrial"
  | "note_facedb"
  | "note_clearLogs"
  | "note_notSent"
  | "note_fault";

// The sentences the kiosk (main/app_tasks.c) and the server write into resultNote; anything else shows as written (KEHOACH 4.6).
const NOTES: [RegExp, NoteKey, string[]][] = [
  [/^door held (\d+) ms$/, "note_doorHeld", ["ms"]],
  [/^sntp asked again$/, "note_sntp", []],
  [/^heartbeat published$/, "note_heartbeat", []],
  [/^ticket renewal queued$/, "note_renewal", []],
  [/^bench password holds no ticket$/, "note_noTicket", []],
  [/^rebooting$/, "note_rebooting", []],
  [/^light (\d+) vol (\d+) (vi|en) dedup (\d+) face (\d+) wake (\d+)$/, "note_config", ["light", "volume", "lang", "dedup", "face", "wake"]],
  [/^a field lies outside the contract's range$/, "note_configRange", []],
  [/^slot (\d) is the one running$/, "note_slotRunning", ["slot"]],
  [/^slot (\d) holds no whole image$/, "note_slotEmpty", ["slot"]],
  [/^slot (\d) on trial, rebooting$/, "note_slotTrial", ["slot"]],
  [/^svc_facedb loads once at boot$/, "note_facedb", []],
  [/^no log erase api yet$/, "note_clearLogs", []],
  [/^not sent: /, "note_notSent", []],
  [/^(ESP_[A-Z0-9_]+)$/, "note_fault", ["code"]],
];

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

/** The result note in the reader's language when it is one the kiosk or the server is known to write. */
function useNote(): (note: string) => string {
  const t = useTranslations("devices");
  const format = useFormatter();
  return (note) => {
    for (const [pattern, key, names] of NOTES) {
      const found = pattern.exec(note);
      if (!found) {
        continue;
      }
      const values: Record<string, string> = Object.fromEntries(names.map((name, at) => [name, found[at + 1] ?? ""]));
      if (values.ms !== undefined) {
        values.seconds = format.number(Number(values.ms) / 1000, { maximumFractionDigits: 1 });
      }
      if (values.lang !== undefined) {
        values.lang = t(`lang_${values.lang as "vi" | "en"}`);
      }
      return t(key, values);
    }
    return note;
  };
}

/** The Commands card of one kiosk: what an ADMIN can ask it now, and how the recent asks ended (KEHOACH 4.6). */
export function KioskCommands({
  deviceId,
  name,
  online,
  activeSlot,
}: {
  deviceId: string;
  name: string;
  online: boolean;
  activeSlot: Slot | null;
}) {
  const t = useTranslations("devices");
  const common = useTranslations("common");
  const format = useFormatter();
  const notify = useNotify();
  const optional = useOptional();
  const noteOf = useNote();
  const cache = useQueryClient();
  const { items } = useFeed();
  const [restarting, setRestarting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const key = ["devices", deviceId, "commands"];

  const recent = useInfiniteQuery({
    queryKey: key,
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const after = pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : "";
      return (await api.get<CommandPage>(`/devices/${deviceId}/commands${after}`)).data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const rows = recent.data?.pages.flatMap((page) => page.rows) ?? [];
  const first = recent.data?.pages[0];

  // The kiosk's answer reaches the feed first, and an unanswered command lapses at its deadline.
  const heard = items.find((item) => item.feed === "event" && item.body.deviceId === deviceId && ANSWERS.has(item.body.type))?.id;
  useEffect(() => {
    if (heard) {
      void cache.invalidateQueries({ queryKey: ["devices", deviceId, "commands"] });
    }
  }, [heard, cache, deviceId]);
  const nextDeadline = rows
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
    mutationFn: async (body: Pick<DeviceCommand, "action" | "config" | "activeSlot">) =>
      (await api.post<CommandRow>(`/devices/${deviceId}/commands`, body)).data,
    onSuccess: (row) => {
      setRestarting(false);
      setSwitching(false);
      setEditing(false);
      notify.done(t("commandSent", { action: t(`command_${row.action}`) }));
      void cache.invalidateQueries({ queryKey: ["devices", deviceId, "commands"] });
    },
    onError: (fell: unknown) => {
      setRestarting(false);
      setSwitching(false);
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
  const lapsed = (row: CommandRow): string | null =>
    row.state === "EXPIRED" && row.expiresAt
      ? t("commandLapsed", { minutes: Math.max(1, Math.round((Date.parse(row.expiresAt) - Date.parse(row.createdAt)) / 60_000)) })
      : null;
  const target: Slot | null = activeSlot === null ? null : activeSlot === 0 ? 1 : 0;

  return (
    <LayerCard>
      <LayerCard.Secondary>{t("commandsTitle")}</LayerCard.Secondary>
      <LayerCard.Primary className="@container/commands flex flex-col gap-4">
        <p className="text-pretty text-kumo-subtle">{online ? t("commandsLead") : t("commandsOffline")}</p>
        <div className="grid grid-cols-2 gap-2 @lg/commands:grid-cols-4">
          {QUICK.map(({ action, icon }) => (
            <Button
              key={action}
              variant="secondary"
              icon={icon}
              className="w-full"
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
            className="w-full"
            disabled={!online || send.isPending}
            onClick={() => {
              setDraft(BLANK);
              setEditing(true);
            }}
          >
            {t("command_SET_CONFIG")}
          </Button>
          <Button
            variant="secondary"
            icon={SwapIcon}
            className="w-full"
            disabled={!online || send.isPending}
            onClick={() => setSwitching(true)}
          >
            {t("command_SET_ACTIVE_SLOT")}
          </Button>
          <Button
            variant="secondary-destructive"
            icon={ArrowCounterClockwiseIcon}
            className="col-span-2 w-full @lg/commands:col-span-1"
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
          <div className="flex flex-col">
            <div className="-mx-2 -mt-1 max-h-96 overflow-y-auto px-2">
              <ul className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3">
                {rows.map((row) => {
                  const at = new Date(row.createdAt);
                  const said = [row.resultNote === null ? lapsed(row) : noteOf(row.resultNote), row.issuedBy].filter(Boolean).join(" · ");
                  return (
                    <li key={row.cmdId} className="col-span-3 grid grid-cols-subgrid items-start border-b border-kumo-hairline py-2 last:border-0">
                      <span className="pt-0.5 text-sm whitespace-nowrap text-kumo-subtle tabular-nums">
                        {format.dateTime(at, stampOptions(at))}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{t(`command_${row.action}`)}</span>
                        <span className="text-sm text-pretty break-words text-kumo-subtle">{said || common("empty")}</span>
                      </span>
                      <StatePill tone={STATE_TONE[row.state]} className="justify-self-end">
                        {t(`commandState_${row.state}`)}
                      </StatePill>
                    </li>
                  );
                })}
              </ul>
            </div>
            {first ? (
              <PagingRow
                className="px-0"
                paging={{
                  shown: rows.length,
                  total: first.total,
                  exact: first.totalIsExact,
                  onMore: recent.hasNextPage ? () => void recent.fetchNextPage() : undefined,
                  loading: recent.isFetchingNextPage,
                }}
              />
            ) : null}
          </div>
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

      <LayerDialog.Alert open={switching} onOpenChange={setSwitching} dismissDisabled={send.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>
            {target === null ? t("slotTitleUnknown", { name }) : t("slotTitle", { name, target })}
          </LayerDialog.Title>
          <LayerDialog.Description>
            {activeSlot === null || target === null ? t("slotUnknown") : t("slotWarn", { running: activeSlot, target })}
          </LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-3">
              <p className="font-mono text-sm text-kumo-subtle">{deviceId}</p>
              {target === null ? (
                <Banner variant="default" icon={<InfoIcon weight="fill" />} description={t("slotAskFirst")} className="text-pretty" />
              ) : (
                <Banner variant="alert" icon={<WarningIcon weight="fill" />} description={t("slotPause")} className="text-pretty" />
              )}
            </div>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              variant="destructive"
              loading={pressing("SET_ACTIVE_SLOT")}
              disabled={target === null}
              onClick={() => target !== null && send.mutate({ action: "SET_ACTIVE_SLOT", activeSlot: target })}
            >
              {target === null ? t("command_SET_ACTIVE_SLOT") : t("slotConfirm", { target })}
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
