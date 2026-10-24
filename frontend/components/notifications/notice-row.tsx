"use client";

import { Banner, LayerDialog, Textarea } from "@cloudflare/kumo";
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  CheckCircleIcon,
  EnvelopeOpenIcon,
  EnvelopeSimpleIcon,
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
import { dayOnly, days } from "@/lib/format";
import { NOTICE_LOOK, type Notice } from "./kinds";

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

function counted(facts: Notice["facts"], name: string): number {
  const value = facts?.[name];
  return typeof value === "number" ? value : 0;
}

/** The words of one notice: what happened, whom and what it is about, and where its work stands. */
export function useNoticeWords() {
  const t = useTranslations("notices");
  const kiosks = useTranslations("devices");
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
      if (notice.kind === "UPDATE_FINISHED") {
        return finished(notice.facts);
      }
      const subject = notice.subject;
      if (!subject || subject.hidden) {
        return null;
      }
      const parts: string[] = [];
      if (subject.person?.fullName && subject.person.id !== employeeId) {
        parts.push(subject.person.fullName);
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
        return { label: item.claimedByName ? `${label} · ${t("stateClaimed", { who: item.claimedByName })}` : label, tone: loud ? "bad" : "waiting" };
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

/** Read, unread, archive or unarchive by ids, or every row of a filter; one toast either way. */
export function useNoticeMarks() {
  const t = useTranslations("notices");
  const cache = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: async ({ action, ids, filter }: { action: MarkAction; ids?: string[]; filter?: NoticeFilter; quiet?: boolean }) =>
      (await api.post<{ changed: number }>(`/notifications/${action}`, ids ? { ids } : { all: true, ...filter })).data,
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

/** The row menu: close open work by hand where the reader may, read or unread, archive or bring back.
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
    return [
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
                <span className="min-w-0 truncate max-md:order-last max-md:basis-full">{about}</span>
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
          {about ? <span className="truncate text-sm text-kumo-subtle">{about}</span> : null}
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-kumo-subtle">
            {pill}
            <span className="tabular-nums">{say.when(notice)}</span>
          </span>
        </span>
      )}
    </span>
  );
}
