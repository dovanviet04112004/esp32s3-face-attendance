"use client";

import { Button, Empty, Loader } from "@cloudflare/kumo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Icon as IconType } from "@phosphor-icons/react";
import {
  CalendarDotsIcon,
  ChatCircleTextIcon,
  BellSimpleIcon,
  CheckSquareIcon,
  CoinsIcon,
  ReceiptIcon,
  TimerIcon,
  TrayIcon,
} from "@phosphor-icons/react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import type { ReactNode } from "react";

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
  | "DISPUTE_ANSWERED"
  | "ADVANCE_PAID";

export interface Notice {
  id: string;
  kind: NoticeKind;
  requestId: string | null;
  advanceId: string | null;
  periodId: string | null;
  contractId: string | null;
  payslipId: string | null;
  certificateId?: string | null;
  profileChangeId?: string | null;
  dependentId?: string | null;
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
  ADVANCE_PAID: CoinsIcon,
};

// Relative times need an instant to count from, or the server and the browser
// each pick their own and the two renders disagree.
const kTickMs = 60_000;

/** The queue and the item a waiting notice opens, read off the one reference it carries. */
function waitingAt(notice: Notice): string {
  if (notice.requestId) {
    return `/leave/${notice.requestId}`;
  }
  const [tab, id] = notice.certificateId
    ? ["certificates", notice.certificateId]
    : notice.profileChangeId
      ? ["profileChanges", notice.profileChangeId]
      : notice.dependentId
        ? ["dependents", notice.dependentId]
        : notice.advanceId
          ? [notice.approved ? "advancesToPay" : "advancesToDecide", notice.advanceId]
          : ["disputes", notice.payslipId ?? ""];
  return `/approvals?tab=${tab}&open=${id}`;
}

/** The page a notice opens, or null when no page says more than the notice itself (KEHOACH 9.21.4). */
function whereOf(notice: Notice): string | null {
  switch (notice.kind) {
    case "REQUEST_WAITING":
      return waitingAt(notice);
    case "REQUEST_DECIDED":
    case "REQUEST_STALLED":
      if (notice.certificateId) {
        return "/me/letters";
      }
      if (notice.profileChangeId || notice.dependentId) {
        return "/me/profile";
      }
      if (notice.advanceId) {
        return "/me/requests?tab=advances";
      }
      return notice.requestId ? `/me/requests?open=${notice.requestId}` : "/me/requests";
    case "ADVANCE_PAID":
      return "/me/requests?tab=advances";
    case "PAYSLIP_ISSUED":
    case "DISPUTE_ANSWERED":
      return notice.payslipId ? `/me/payslips?slip=${notice.payslipId}` : "/me/payslips";
    case "CONTRACT_ENDING":
      return null;
  }
}

/** A notice row: a link where a page says more, otherwise a button that only marks it read. */
function Row({ notice, onRead, onGo, children }: { notice: Notice; onRead: () => void; onGo: () => void; children: ReactNode }) {
  const look = cn(
    "flex min-h-11 w-full items-start gap-3 rounded-md px-2.5 py-2 text-start text-base hover:bg-kumo-tint",
    notice.readAt === null && "bg-kumo-elevated",
  );
  const where = whereOf(notice);
  if (where === null) {
    return (
      <button type="button" className={look} onClick={() => notice.readAt === null && onRead()}>
        {children}
      </button>
    );
  }
  return (
    <Link href={where} className={look} onClick={onGo}>
      {children}
    </Link>
  );
}

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
    switch (notice.kind) {
      case "REQUEST_DECIDED":
        return notice.approved ? t("kindREQUEST_DECIDED_true") : t("kindREQUEST_DECIDED_false");
      case "REQUEST_WAITING":
        return notice.advanceId && notice.approved ? t("kindREQUEST_WAITING_pay") : t("kindREQUEST_WAITING");
      case "REQUEST_STALLED":
        return t("kindREQUEST_STALLED", { count: notice.daysWaited ?? 0 });
      case "CONTRACT_ENDING":
        return t("kindCONTRACT_ENDING", { count: notice.daysLeft ?? 0 });
      case "PAYSLIP_ISSUED":
        return t("kindPAYSLIP_ISSUED");
      case "DISPUTE_ANSWERED":
        return t("kindDISPUTE_ANSWERED");
      case "ADVANCE_PAID":
        return t("kindADVANCE_PAID");
    }
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
                <Row
                  notice={notice}
                  onRead={() => read.mutate(notice.id)}
                  onGo={() => {
                    read.mutate(notice.id);
                    onGo();
                  }}
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
                </Row>
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
