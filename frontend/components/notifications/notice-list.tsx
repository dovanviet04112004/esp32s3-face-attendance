"use client";

import { Button, Empty, Loader } from "@cloudflare/kumo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Icon as IconType } from "@phosphor-icons/react";
import {
  CalendarDotsIcon,
  ChatCircleTextIcon,
  BellSimpleIcon,
  CheckSquareIcon,
  ReceiptIcon,
  TimerIcon,
  TrayIcon,
} from "@phosphor-icons/react";
import { useFormatter, useNow, useTranslations } from "next-intl";

import { useNotify } from "@/components/ui/notify";
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

const FACE: Record<NoticeKind, IconType> = {
  REQUEST_DECIDED: CheckSquareIcon,
  REQUEST_WAITING: TrayIcon,
  REQUEST_STALLED: TimerIcon,
  PAYSLIP_ISSUED: ReceiptIcon,
  CONTRACT_ENDING: CalendarDotsIcon,
  DISPUTE_ANSWERED: ChatCircleTextIcon,
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
  const format = useFormatter();
  const now = useNow({ updateInterval: kTickMs });
  const cache = useQueryClient();
  const notify = useNotify();

  const notices = useQuery({
    queryKey: ["notifications"],
    queryFn: async () => (await api.get<Notice[]>("/notifications")).data,
  });

  const read = useMutation({
    mutationFn: (id?: string) => api.post(id ? `/notifications/${id}/read` : "/notifications/read"),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["notifications"] }),
    onError: notify.failed,
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
      {notices.isPending ? (
        <div className="grid place-items-center py-8">
          <Loader />
        </div>
      ) : rows.length === 0 ? (
        <Empty size="sm" icon={<BellSimpleIcon size={32} className="text-kumo-inactive" />} title={t("empty")} />
      ) : (
        <ul className="flex max-h-[min(28rem,70dvh)] flex-col overflow-y-auto p-1.5">
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
                    "flex min-h-11 items-start gap-3 rounded-md px-2.5 py-2 text-base hover:bg-kumo-tint",
                    notice.readAt === null && "bg-kumo-elevated",
                  )}
                >
                  <Icon className="mt-0.5 size-4 shrink-0 text-kumo-subtle" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block">{say(notice)}</span>
                    <span className="block text-sm text-kumo-subtle">
                      {format.relativeTime(new Date(notice.createdAt), now)}
                    </span>
                  </span>
                  {notice.readAt === null ? (
                    <span className="mt-1.5 size-2 shrink-0 rounded-full bg-kumo-brand" aria-hidden />
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {rows.some((row) => row.readAt === null) ? (
        <div className="border-t border-kumo-hairline p-2">
          <Button variant="ghost" size="sm" className="w-full" loading={read.isPending} onClick={() => read.mutate(undefined)}>
            {t("markAll")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
