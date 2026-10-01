"use client";

import { ArchiveIcon, ArrowCounterClockwiseIcon, EnvelopeOpenIcon, EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useLocale, useNow, useTranslations } from "next-intl";
import { useEffect } from "react";

import { useShortSpan } from "@/components/requests/inbox-preview";
import { useRequestWords } from "@/components/requests/request-card";
import type { RowAction } from "@/components/tables/data-table";
import { useNotify } from "@/components/ui/notify";
import { StatePill, type Tone } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { days } from "@/lib/format";
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

/** The words of one notice: what happened, whom and what it is about, and where its work stands. */
export function useNoticeWords() {
  const t = useTranslations("notices");
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

  return {
    sentence(notice: Notice): string {
      const said = NOTICE_LOOK[notice.kind].sentence(notice);
      return said.count === undefined ? t(said.key) : t(said.key, { count: said.count });
    },

    /** The person and the request behind a notice, leaving out the reader themselves. */
    about(notice: Notice): string | null {
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

/** The row menu: read or unread, archive or bring back. */
export function useNoticeActions(): (notice: Notice) => RowAction[] {
  const t = useTranslations("notices");
  const marks = useNoticeMarks();
  const mark = (action: MarkAction, notice: Notice) => () => marks.mutate({ action, ids: [notice.id] });
  return (notice) => [
    notice.readAt === null
      ? { key: "read", label: t("markRead"), icon: EnvelopeOpenIcon, onSelect: mark("read", notice) }
      : { key: "unread", label: t("markUnread"), icon: EnvelopeSimpleIcon, onSelect: mark("unread", notice) },
    notice.archivedAt
      ? { key: "unarchive", label: t("unarchive"), icon: ArrowCounterClockwiseIcon, onSelect: mark("unarchive", notice) }
      : { key: "archive", label: t("archive"), icon: ArchiveIcon, onSelect: mark("archive", notice) },
  ];
}

/** One notice as the bell and the page both draw it; "phone" shows the state only where no state column stands beside it (KEHOACH 9.21.4). */
export function NoticeLine({ notice, state = "always" }: { notice: Notice; state?: "always" | "phone" }) {
  const t = useTranslations("notices");
  const say = useNoticeWords();
  const Icon = NOTICE_LOOK[notice.kind].icon;
  const about = say.about(notice);
  const where = say.state(notice);
  const unread = notice.readAt === null && notice.leftAt === null;
  return (
    <span className="flex min-w-0 flex-1 items-start gap-3 font-normal whitespace-normal">
      <Icon className="mt-0.5 size-4 shrink-0 text-kumo-subtle" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className={cn("break-words", unread && "font-medium")}>{say.sentence(notice)}</span>
        {about ? <span className="truncate text-sm text-kumo-subtle">{about}</span> : null}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-kumo-subtle">
          {where ? (
            <StatePill tone={where.tone} className={state === "phone" ? "md:hidden" : undefined}>
              {where.label}
            </StatePill>
          ) : null}
          <span className="tabular-nums">{say.when(notice)}</span>
        </span>
      </span>
      {unread ? <span className="mt-1.5 size-2 shrink-0 rounded-full bg-kumo-brand" role="img" aria-label={t("unreadDot")} /> : null}
    </span>
  );
}
