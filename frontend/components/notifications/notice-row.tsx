"use client";

import { Banner, LayerDialog, Textarea } from "@cloudflare/kumo";
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  CheckCircleIcon,
  EnvelopeOpenIcon,
  EnvelopeSimpleIcon,
  UserCheckIcon,
  UserMinusIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useLocale, useNow, useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";

import { useShortSpan } from "@/components/requests/inbox-preview";
import { useRequestWords } from "@/components/requests/request-card";
import type { RowAction } from "@/components/tables/data-table";
import { useNotify } from "@/components/ui/notify";
import { useOptional } from "@/components/ui/optional";
import { StatePill, type Tone } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { useFault } from "@/lib/fault";
import { dayOf, dayOnly, days, todayIso } from "@/lib/format";
import { isDeviceEvent } from "@/lib/ws";
import { NOTICE_LOOK, type Notice, type NoticeSentence } from "./kinds";

export type NoticeStatus = "action" | "unread" | "all" | "archived";

export type MarkAction = "read" | "unread" | "archive" | "unarchive";

/** What a list narrows by; every field narrows, none widens. */
export interface NoticeFilter {
  status?: NoticeStatus;
  category?: string;
  from?: string;
  to?: string;
  search?: string;
}

export interface NoticeCounts {
  unread: number;
  action: number;
  critical: number;
}

/** Every notice query starts with this, so one invalidation refreshes the bell, the page and the counts. */
export const NOTICES_KEY = ["notifications"] as const;

// Relative times need an instant to count from, or the server and the browser each pick their own.
const kTickMs = 60_000;
const kDayMs = 86_400_000;
const kNoteMax = 500;

type Fact = "lateMinutes" | "earlyMinutes" | "overtimeMinutes";
type TeamCount = "late" | "notPunched" | "absent" | "onLeave";

const MINUTE_FACTS: Record<Fact, "factLate" | "factEarly" | "factOvertime"> = {
  lateMinutes: "factLate",
  earlyMinutes: "factEarly",
  overtimeMinutes: "factOvertime",
};

const TEAM_COUNTS: Record<TeamCount, "teamLate" | "teamNotPunched" | "teamAbsent" | "teamOnLeave"> = {
  late: "teamLate",
  notPunched: "teamNotPunched",
  absent: "teamAbsent",
  onLeave: "teamOnLeave",
};

// These kiosk sentences name only a family of codes, so the row names the code itself beside them.
const FAMILY_SENTENCES: ReadonlySet<NoticeSentence> = new Set<NoticeSentence>(["kindKIOSK_ALERT_fault", "kindKIOSK_ALERT_update"]);

// The inbox tab a waiting record sits in; a request names its own kind instead.
const WAITING_QUEUES: Readonly<Record<string, "queueDisputes" | "queueCertificates" | "queueProfile" | "queueDependents">> = {
  DISPUTE: "queueDisputes",
  CERTIFICATE: "queueCertificates",
  PROFILE_CHANGE: "queueProfile",
  DEPENDENT: "queueDependents",
};

const FILED_KINDS: Readonly<Record<string, "kindDispute" | "kindCertificate" | "kindProfileChange" | "kindDependent" | "kindAdvance">> = {
  DISPUTE: "kindDispute",
  CERTIFICATE: "kindCertificate",
  PROFILE_CHANGE: "kindProfileChange",
  DEPENDENT: "kindDependent",
  ADVANCE: "kindAdvance",
};

// The codes the backup watch reports, as payroll/mail-text.ts names them (KEHOACH 9.22.2).
const BACKUP_CODES = ["WAL_FAILING", "DUMP_STALE", "BIOMETRIC_STALE", "BASE_STALE", "WAL_STALE", "OFFSITE_STALE"] as const;
type BackupCode = (typeof BACKUP_CODES)[number];

function isBackupCode(code: string): code is BackupCode {
  return (BACKUP_CODES as readonly string[]).includes(code);
}

function counted(facts: Notice["facts"], name: string): number {
  const value = facts?.[name];
  return typeof value === "number" ? value : 0;
}

/** The words of one notice: what happened, whom and what it is about, and where its work stands. */
export function useNoticeWords() {
  const t = useTranslations("notices");
  const kiosks = useTranslations("devices");
  const inbox = useTranslations("requests");
  const records = useTranslations("search");
  const format = useFormatter();
  const locale = useLocale();
  const now = useNow({ updateInterval: kTickMs });
  const words = useRequestWords();
  const shortSpan = useShortSpan();
  const { userId, employeeId } = useSession();

  function closedAt(iso: string): string {
    const at = new Date(iso);
    const today = at.toDateString() === now.toDateString();
    return format.dateTime(at, today ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  /** The company day open work is due, read as overdue once that day has gone. */
  function dueBy(iso: string): string {
    const due = dayOf(iso);
    const day = format.dateTime(dayOnly(due), { day: "numeric", month: "numeric" });
    return due < todayIso() ? t("stateOverdue", { day }) : t("stateDue", { day });
  }

  /** What is off on a day, in the order a person reads their day: absent or a punch missing first. */
  function deviations(facts: Notice["facts"]): string[] {
    const said: string[] = [];
    if (facts?.absent === true) {
      said.push(t("factAbsent"));
    }
    if (facts?.missing === "IN" || facts?.missing === "OUT") {
      said.push(t(facts.missing === "IN" ? "factMissingIn" : "factMissingOut"));
    }
    for (const fact of Object.keys(MINUTE_FACTS) as Fact[]) {
      const minutes = counted(facts, fact);
      if (minutes > 0) {
        said.push(t(MINUTE_FACTS[fact], { minutes }));
      }
    }
    return said;
  }

  function team(facts: Notice["facts"]): string {
    const said = (Object.keys(TEAM_COUNTS) as TeamCount[]).flatMap((count) =>
      counted(facts, count) > 0 ? [t(TEAM_COUNTS[count], { count: counted(facts, count) })] : [],
    );
    return said.length > 0 ? said.join(" · ") : t("teamAllIn");
  }

  function release(facts: Notice["facts"]): string | null {
    const target = facts?.target;
    const version = facts?.version;
    if ((target !== "FIRMWARE" && target !== "MODELS") || typeof version !== "string") {
      return null;
    }
    const named = `${kiosks(`target${target}`)} ${version}`;
    return facts?.recognition === true ? `${named} · ${t("releaseRecognition")}` : named;
  }

  function finished(facts: Notice["facts"]): string | null {
    const firmware = facts?.firmware;
    const models = facts?.models;
    return typeof firmware === "string" && typeof models === "string" ? t("updateRuns", { firmware, models }) : null;
  }

  /** The queue a waiting record sits in, or what a record the reader filed is; a request says its own kind. */
  function queueOf(notice: Notice): string | null {
    const type = notice.subject?.type ?? "";
    if (notice.kind === "REQUEST_WAITING") {
      const queue = type === "ADVANCE" ? (notice.approved ? "queueToPay" : "queueAdvances") : WAITING_QUEUES[type];
      return queue ? inbox(queue) : null;
    }
    const kind = notice.kind === "REQUEST_DECIDED" || notice.kind === "REQUEST_STALLED" ? FILED_KINDS[type] : undefined;
    return kind ? records(kind) : null;
  }

  /** Each backup the watch finds failing, in words; a code this page does not know reads as itself. */
  function backup(facts: Notice["facts"]): string | null {
    const problems = typeof facts?.problems === "string" ? facts.problems.split(",").filter(Boolean) : [];
    return problems.map((code) => (isBackupCode(code) ? t(`backup_${code}`) : code)).join(" · ") || null;
  }

  /** The kiosk by its name, or by its id until somebody names it. */
  function kioskName(notice: Notice): string | null {
    const subject = notice.subject;
    return subject?.id ? (subject.device?.name ?? subject.id) : null;
  }

  /** The kiosk, the code its sentence leaves unnamed, and the number the kiosk reported with it. */
  function kiosk(notice: Notice): string | null {
    const said = [kioskName(notice)];
    const code = notice.facts?.code;
    if (FAMILY_SENTENCES.has(NOTICE_LOOK.KIOSK_ALERT.sentence(notice).key) && isDeviceEvent(code)) {
      said.push(kiosks(`event_${code}`));
    }
    const errorCode = notice.facts?.errorCode;
    if (typeof errorCode === "number") {
      said.push(t("kioskErrorCode", { code: String(errorCode) }));
    }
    return said.filter(Boolean).join(" · ") || null;
  }

  return {
    deviations,

    sentence(notice: Notice): string {
      const said = NOTICE_LOOK[notice.kind].sentence(notice);
      if (said.day !== undefined) {
        return t(said.key, { day: shortSpan({ fromDate: said.day, toDate: said.day }) });
      }
      if (said.month !== undefined) {
        return t(said.key, { month: format.dateTime(dayOnly(`${said.month}-01`), { month: "numeric", year: "numeric" }) });
      }
      return said.count === undefined ? t(said.key) : t(said.key, { count: said.count });
    },

    /** The person and the request behind a notice, leaving out the reader themselves; a day's deviations or a team's counts. */
    about(notice: Notice): string | null {
      if (notice.kind === "ATTENDANCE_EXCEPTION") {
        return deviations(notice.facts).join(" · ") || null;
      }
      if (notice.kind === "TEAM_ATTENDANCE") {
        return team(notice.facts);
      }
      if (notice.kind === "RELEASE_AVAILABLE") {
        return release(notice.facts);
      }
      if (notice.kind === "KIOSK_ALERT") {
        return kiosk(notice);
      }
      if (notice.kind === "BACKUP_ALERT") {
        return backup(notice.facts);
      }
      if (notice.kind === "UPDATE_FINISHED") {
        return [kioskName(notice), finished(notice.facts)].filter(Boolean).join(" · ") || null;
      }
      const subject = notice.subject;
      if (!subject || subject.hidden) {
        return null;
      }
      const parts: string[] = [];
      if (subject.person?.fullName && subject.person.id !== employeeId) {
        parts.push(subject.person.fullName);
      }
      const queue = queueOf(notice);
      if (queue) {
        parts.push(queue);
      }
      if (subject.request) {
        const request = subject.request;
        parts.push(request.leaveType?.name ?? words.kind(request), shortSpan(request), days(Number(request.days), locale));
      }
      return parts.length > 0 ? parts.join(" · ") : null;
    },

    state(notice: Notice): { label: string; tone: Tone } | null {
      if (notice.leftAt !== null) {
        return { label: t("stateMoved"), tone: "idle" };
      }
      const item = notice.item;
      if (!item) {
        return null;
      }
      if (item.state === "OPEN") {
        const waited = Math.max(0, Math.floor((now.getTime() - new Date(item.openedAt).getTime()) / kDayMs));
        const label = t("stateOpen", { count: waited });
        const loud = item.level === "WARNING" || item.level === "CRITICAL";
        const claimed =
          item.claimedById !== null && item.claimedById === userId
            ? t("stateClaimedSelf")
            : item.claimedByName
              ? t("stateClaimed", { who: item.claimedByName })
              : null;
        const due = item.dueAt ? dueBy(item.dueAt) : null;
        return { label: [label, due, claimed].filter(Boolean).join(" · "), tone: loud ? "bad" : "waiting" };
      }
      if (item.state === "DONE") {
        const outcome = item.outcome ?? "other";
        const time = item.closedAt ? closedAt(item.closedAt) : "";
        if (item.actorId !== null && item.actorId === userId) {
          return { label: t("doneSelf", { outcome, time }), tone: "good" };
        }
        return {
          label: item.actorName ? t("doneBy", { outcome, who: item.actorName, time }) : t("doneQuiet", { outcome, time }),
          tone: item.outcome === "REJECTED" ? "idle" : "good",
        };
      }
      return { label: t(`state${item.state}`), tone: "idle" };
    },

    when(notice: Notice): string {
      return format.relativeTime(new Date(notice.remindedAt ?? notice.createdAt), now);
    },
  };
}

/** The fields of a filter that narrow; an empty one is no filter, and the api refuses it as a value. */
function narrowing(filter: NoticeFilter = {}): NoticeFilter {
  return Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== undefined && value !== ""));
}

/** Read, unread, archive or unarchive by ids, or every row of a filter; one toast either way. */
export function useNoticeMarks() {
  const t = useTranslations("notices");
  const cache = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: async ({ action, ids, filter }: { action: MarkAction; ids?: string[]; filter?: NoticeFilter; quiet?: boolean }) =>
      (await api.post<{ changed: number }>(`/notifications/${action}`, ids ? { ids } : { all: true, ...narrowing(filter) })).data,
    onSuccess: (marked, { action, quiet }) => {
      if (!quiet) {
        notify.done(t(`marked_${action}`, { count: marked.changed }));
      }
      void cache.invalidateQueries({ queryKey: NOTICES_KEY });
    },
    onError: (fell: unknown) => notify.failed(fell),
  });
}

/** Every notice about one record reads as read once its page opens, quietly (KEHOACH 9.21.4). */
export function useReadSubject(type: string, id: string | null | undefined): void {
  const cache = useQueryClient();
  useEffect(() => {
    if (!id) {
      return;
    }
    api.post<{ changed: number }>("/notifications/read", { subject: { type, id } }).then(
      (marked) => marked.data.changed > 0 && void cache.invalidateQueries({ queryKey: NOTICES_KEY }),
      () => undefined,
    );
  }, [type, id]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The row menu: claim open work or let go of it, close it by hand where the reader may, read or unread, archive or bring back.
 *  `dialog` asks for the close's note and must render outside any popover the menu sits in.
 *  @param beforeDialog called as the note dialog opens, so a popover can close first
 */
export function useNoticeActions(beforeDialog?: () => void): { actionsOf: (notice: Notice) => RowAction[]; dialog: ReactNode } {
  const t = useTranslations("notices");
  const common = useTranslations("common");
  const say = useNoticeWords();
  const optional = useOptional();
  const marks = useNoticeMarks();
  const cache = useQueryClient();
  const notify = useNotify();
  const faultOf = useFault();
  const userId = useSession((s) => s.userId);
  const [closing, setClosing] = useState<Notice | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [fault, setFault] = useState<string | null>(null);

  const resolve = useMutation({
    mutationFn: ({ key, said }: { key: string; said: string }) =>
      api.post(`/notifications/items/${encodeURIComponent(key)}/resolve`, { note: said }),
    onSuccess: () => {
      setAsking(false);
      notify.done(t("resolved"));
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
    onSettled: () => void cache.invalidateQueries({ queryKey: NOTICES_KEY }),
  });

  const claim = useMutation({
    mutationFn: ({ key, taking }: { key: string; taking: boolean }) =>
      taking
        ? api.post(`/notifications/items/${encodeURIComponent(key)}/claim`, {})
        : api.delete(`/notifications/items/${encodeURIComponent(key)}/claim`),
    onSuccess: (_, { taking }) => notify.done(t(taking ? "claimed" : "unclaimed")),
    onError: (fell: unknown) => notify.failed(fell),
    onSettled: () => void cache.invalidateQueries({ queryKey: NOTICES_KEY }),
  });

  function startClosing(notice: Notice): void {
    beforeDialog?.();
    setNote("");
    setFault(null);
    setClosing(notice);
    setAsking(true);
  }

  const mark = (action: MarkAction, notice: Notice) => () => marks.mutate({ action, ids: [notice.id] });
  const actionsOf = (notice: Notice): RowAction[] => {
    const open = notice.item?.state === "OPEN" && notice.leftAt === null ? notice.item : null;
    // A day is let go on its own page, beside the request that explains it (KEHOACH 9.21.4).
    const closable = open?.resolvable === true && notice.kind !== "ATTENDANCE_EXCEPTION";
    const taking = open?.claimable === true ? open.claimedById !== userId : null;
    return [
      ...(open && taking !== null
        ? [
            taking
              ? { key: "claim", label: t("claim"), icon: UserCheckIcon, onSelect: () => claim.mutate({ key: open.key, taking }) }
              : { key: "unclaim", label: t("unclaim"), icon: UserMinusIcon, onSelect: () => claim.mutate({ key: open.key, taking }) },
          ]
        : []),
      ...(closable ? [{ key: "resolve", label: t("resolve"), icon: CheckCircleIcon, onSelect: () => startClosing(notice) }] : []),
      notice.readAt === null
        ? { key: "read", label: t("markRead"), icon: EnvelopeOpenIcon, onSelect: mark("read", notice) }
        : { key: "unread", label: t("markUnread"), icon: EnvelopeSimpleIcon, onSelect: mark("unread", notice) },
      notice.archivedAt
        ? { key: "unarchive", label: t("unarchive"), icon: ArrowCounterClockwiseIcon, onSelect: mark("unarchive", notice) }
        : { key: "archive", label: t("archive"), icon: ArchiveIcon, onSelect: mark("archive", notice) },
    ];
  };

  const about = closing ? say.about(closing) : null;
  const dialog = (
    <LayerDialog.Root open={asking} onOpenChange={(next) => !next && setAsking(false)} dismissDisabled={resolve.isPending}>
      <LayerDialog.Content closeLabel={common("close")}>
        <LayerDialog.Title>{t("resolveTitle")}</LayerDialog.Title>
        <LayerDialog.Description>{t("resolveLead")}</LayerDialog.Description>
        <LayerDialog.Body>
          <div className="flex flex-col gap-4">
            {closing ? (
              <div className="flex flex-col gap-0.5 rounded-lg border border-kumo-hairline px-3 py-2">
                <span className="font-medium">{say.sentence(closing)}</span>
                {about ? <span className="text-sm text-kumo-subtle">{about}</span> : null}
              </div>
            ) : null}
            <Textarea
              label={optional(t("resolveNote"))}
              description={t("resolveNoteHint")}
              rows={3}
              maxLength={kNoteMax}
              value={note}
              onValueChange={setNote}
            />
            {fault ? <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null}
          </div>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel={common("cancel")}>
          <LayerDialog.Actions.Primary
            loading={resolve.isPending}
            onClick={() => closing?.item && resolve.mutate({ key: closing.item.key, said: note.trim() })}
          >
            {t("resolveConfirm")}
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
  return { actionsOf, dialog };
}

/** One notice as the bell and the page both draw it, the unread dot ahead of the icon in both. "phone" is the
 *  page's row: two lines like every other row, the state only where no state column stands beside it (KEHOACH 9.12, 9.21.4).
 */
export function NoticeLine({ notice, state = "always" }: { notice: Notice; state?: "always" | "phone" }) {
  const t = useTranslations("notices");
  const say = useNoticeWords();
  const Icon = NOTICE_LOOK[notice.kind].icon;
  const about = say.about(notice);
  const where = say.state(notice);
  const unread = notice.readAt === null && notice.leftAt === null;
  const row = state === "phone";
  const pill = where ? (
    <StatePill tone={where.tone} className={cn("shrink-0", row && "md:hidden")}>
      {where.label}
    </StatePill>
  ) : null;
  return (
    <span className={cn("flex min-w-0 flex-1 gap-2.5 font-normal", row ? "items-center" : "items-start")}>
      <span className={cn("flex w-2 shrink-0 justify-center", !row && "mt-1.5")}>
        {unread ? <span className="size-2 rounded-full bg-kumo-brand" role="img" aria-label={t("unreadDot")} /> : null}
      </span>
      <Icon className={cn("size-4 shrink-0 text-kumo-subtle", !row && "mt-0.5")} aria-hidden />
      {row ? (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn("max-md:line-clamp-2 max-md:whitespace-normal md:truncate", unread && "font-medium")}>{say.sentence(notice)}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-kumo-subtle max-md:flex-wrap">
            {pill}
            {about ? (
              <>
                <span title={about} className="min-w-0 truncate max-md:order-last max-md:basis-full">
                  {about}
                </span>
                <span aria-hidden className="max-md:hidden">
                  ·
                </span>
              </>
            ) : null}
            <span className="shrink-0 tabular-nums">{say.when(notice)}</span>
          </span>
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col gap-1 whitespace-normal">
          <span className={cn("break-words", unread && "font-medium")}>{say.sentence(notice)}</span>
          {about ? (
            <span title={about} className="truncate text-sm text-kumo-subtle">
              {about}
            </span>
          ) : null}
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-kumo-subtle">
            {pill}
            <span className="tabular-nums">{say.when(notice)}</span>
          </span>
        </span>
      )}
    </span>
  );
}
