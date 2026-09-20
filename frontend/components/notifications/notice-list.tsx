"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Inbox, Receipt, SquareCheck, type LucideIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";

export type NoticeKind =
  | "REQUEST_DECIDED"
  | "REQUEST_WAITING"
  | "PAYSLIP_ISSUED"
  | "CONTRACT_ENDING";

export interface Notice {
  id: string;
  kind: NoticeKind;
  requestId: string | null;
  periodId: string | null;
  contractId: string | null;
  daysLeft: number | null;
  approved: boolean | null;
  readAt: string | null;
  createdAt: string;
}

const FACE: Record<NoticeKind, LucideIcon> = {
  REQUEST_DECIDED: SquareCheck,
  REQUEST_WAITING: Inbox,
  PAYSLIP_ISSUED: Receipt,
  CONTRACT_ENDING: CalendarClock,
};

const WHERE: Record<NoticeKind, string> = {
  REQUEST_DECIDED: "/me/requests",
  REQUEST_WAITING: "/approvals",
  PAYSLIP_ISSUED: "/me/payslips",
  CONTRACT_ENDING: "/me",
};

export function NoticeList({ onGo }: { onGo: () => void }) {
  const t = useTranslations("notices");
  const format = useFormatter();
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
    return notice.kind === "REQUEST_WAITING" ? t("kindREQUEST_WAITING") : t("kindPAYSLIP_ISSUED");
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

      {rows.length === 0 ? (
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
                      {format.relativeTime(new Date(notice.createdAt))}
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
