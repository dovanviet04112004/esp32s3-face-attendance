"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  Inbox,
  MessageSquareReply,
  Receipt,
  SquareCheck,
  TimerOff,
  type LucideIcon,
} from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";

export type NoticeKind =
  | "REQUEST_DECIDED"
  | "REQUEST_WAITING"
  | "REQUEST_STALLED"
  | "PAYSLIP_ISSUED"
  | "CONTRACT_ENDING"
  | "DISPUTE_ANSWERED";

export interface Notice {
  id: string;
  kind: NoticeKind;
  requestId: string | null;
  advanceId: string | null;
  periodId: string | null;
  contractId: string | null;
  payslipId: string | null;
  daysLeft: number | null;
  daysWaited: number | null;
  approved: boolean | null;
  readAt: string | null;
  createdAt: string;
}

const FACE: Record<NoticeKind, LucideIcon> = {
  REQUEST_DECIDED: SquareCheck,
  REQUEST_WAITING: Inbox,
  REQUEST_STALLED: TimerOff,
  PAYSLIP_ISSUED: Receipt,
  CONTRACT_ENDING: CalendarClock,
  DISPUTE_ANSWERED: MessageSquareReply,
};

// Relative times need an instant to count from, or the server and the browser
// each pick their own and the two renders disagree.
const kTickMs = 60_000;

const WHERE: Record<NoticeKind, string> = {
  REQUEST_DECIDED: "/me/requests",
  REQUEST_WAITING: "/approvals",
  REQUEST_STALLED: "/me/requests",
  PAYSLIP_ISSUED: "/me/payslips",
  CONTRACT_ENDING: "/me",
  DISPUTE_ANSWERED: "/me/payslips",
};

export function NoticeList({ onGo }: { onGo: () => void }) {
  const t = useTranslations("notices");
  const common = useTranslations("common");
  const format = useFormatter();
  const now = useNow({ updateInterval: kTickMs });
  const cache = useQueryClient();

  const notices = useQuery({
    queryKey: ["notifications"],
    queryFn: async () => (await api.get<Notice[]>("/notifications")).data,
  });

  const read = useMutation({
    mutationFn: (id?: string) => api.post(id ? `/notifications/${id}/read` : "/notifications/read"),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["notifications"] }),
  });

  // The row holds a kind and references; the sentence is built here.
  function say(notice: Notice): string {
    if (notice.kind === "REQUEST_DECIDED") {
      return notice.approved ? t("kindREQUEST_DECIDED_true") : t("kindREQUEST_DECIDED_false");
    }
    if (notice.kind === "CONTRACT_ENDING") {
      return t("kindCONTRACT_ENDING", { count: notice.daysLeft ?? 0 });
    }
    if (notice.kind === "REQUEST_STALLED") {
      return t("kindREQUEST_STALLED", { count: notice.daysWaited ?? 0 });
    }
    if (notice.kind === "REQUEST_WAITING") {
      return t("kindREQUEST_WAITING");
    }
    return notice.kind === "DISPUTE_ANSWERED"
      ? t("kindDISPUTE_ANSWERED")
      : t("kindPAYSLIP_ISSUED");
  }

  const rows = notices.data ?? [];

  return (
    <div>
      {rows.some((row) => row.readAt === null) ? (
        <Button
          type="button"
          tone="quiet"
          size="sm"
          className="mb-2 w-full"
          onClick={() => read.mutate(undefined)}
        >
          {t("markAll")}
        </Button>
      ) : null}

      {notices.isPending ? (
        <p className="px-2 py-6 text-center text-sm text-(--color-muted)">{common("loading")}</p>
      ) : rows.length === 0 ? (
        <p className="px-2 py-6 text-center text-sm text-(--color-muted)">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((notice) => {
            const Icon = FACE[notice.kind];
            return (
              <li key={notice.id}>
                <Link
                  href={WHERE[notice.kind]}
                  onClick={() => {
                    read.mutate(notice.id);
                    onGo();
                  }}
                  className={cn(
                    "flex min-h-11 items-start gap-3 rounded-lg px-2 py-2 text-sm hover:bg-(--color-ground)",
                    notice.readAt === null && "bg-(--color-ground)",
                  )}
                >
                  <Icon className="mt-0.5 size-4 shrink-0 text-(--color-muted)" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block">{say(notice)}</span>
                    <span className="block text-xs text-(--color-muted)">
                      {format.relativeTime(new Date(notice.createdAt), now)}
                    </span>
                  </span>
                  {notice.readAt === null ? (
                    <span className="mt-1.5 size-2 shrink-0 rounded-full bg-(--color-accent)" />
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
