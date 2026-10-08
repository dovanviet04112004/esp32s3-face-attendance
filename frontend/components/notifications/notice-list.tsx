"use client";

import { Empty, Loader } from "@cloudflare/kumo";
import { BellSimpleIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { ActionMenu } from "@/components/tables/data-table";
import { Failed } from "@/components/ui/failed";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { NOTICE_LOOK, useReader, type Notice } from "./kinds";
import { NOTICES_KEY, NoticeLine, useNoticeActions, useNoticeMarks, type NoticeStatus } from "./notice-row";

const kBellTake = 20;

const EMPTY: Record<NoticeStatus, "emptyAction" | "emptyUnread" | "empty" | "emptyArchived"> = {
  action: "emptyAction",
  unread: "emptyUnread",
  all: "empty",
  archived: "emptyArchived",
};

/** A notice row: a link where a page says more, otherwise a button that only marks it read. */
function Opener({ notice, onRead, onGo, children }: { notice: Notice; onRead: () => void; onGo: () => void; children: ReactNode }) {
  const look = "flex min-h-11 min-w-0 flex-1 items-start rounded-md px-2.5 py-2 text-start text-base hover:bg-kumo-tint";
  const reader = useReader();
  const where = NOTICE_LOOK[notice.kind].path(notice, reader);
  if (where === null) {
    return (
      <button type="button" className={look} onClick={onRead}>
        {children}
      </button>
    );
  }
  return (
    <Link
      href={where}
      className={look}
      onClick={() => {
        onRead();
        onGo();
      }}
    >
      {children}
    </Link>
  );
}

/** The bell's rows for one tab, newest first. */
export function NoticeList({ status, onGo }: { status: NoticeStatus; onGo: () => void }) {
  const t = useTranslations("notices");
  const marks = useNoticeMarks();
  const actionsOf = useNoticeActions();

  const notices = useQuery({
    queryKey: [...NOTICES_KEY, "bell", status],
    queryFn: async () => (await api.get<{ rows: Notice[] }>(`/notifications?status=${status}&take=${kBellTake}`)).data.rows,
  });

  if (notices.isPending) {
    return (
      <div className="grid place-items-center py-8">
        <Loader />
      </div>
    );
  }
  if (notices.isError) {
    return (
      <div className="p-4">
        <Failed onRetry={() => void notices.refetch()} />
      </div>
    );
  }
  if (notices.data.length === 0) {
    return <Empty size="sm" icon={<BellSimpleIcon size={32} className="text-kumo-inactive" />} title={t(EMPTY[status])} />;
  }
  return (
    <ul className="flex max-h-[min(28rem,60dvh)] flex-col overflow-y-auto p-1.5">
      {notices.data.map((notice) => (
        <li key={notice.id} className={cn("flex items-start gap-1 rounded-md", notice.readAt === null && notice.leftAt === null && "bg-kumo-elevated")}>
          <Opener
            notice={notice}
            onRead={() => notice.readAt === null && marks.mutate({ action: "read", ids: [notice.id], quiet: true })}
            onGo={onGo}
          >
            <NoticeLine notice={notice} />
          </Opener>
          <span className="pt-1.5 pr-1">
            <ActionMenu actions={actionsOf(notice)} label={t("rowMenu")} />
          </span>
        </li>
      ))}
    </ul>
  );
}
