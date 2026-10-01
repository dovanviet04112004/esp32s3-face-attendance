"use client";

import { Badge, Button, LinkButton, Popover, Tabs } from "@cloudflare/kumo";
import { BellIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { NoticeList } from "./notice-list";
import { NOTICES_KEY, useNoticeMarks, type NoticeCounts, type NoticeStatus } from "./notice-row";

const kPollMs = 60_000;
const kMaxShown = 9;
const TABS: NoticeStatus[] = ["action", "unread", "all"];

const TAB_KEY: Record<NoticeStatus, "tabAction" | "tabUnread" | "tabAll" | "tabArchived"> = {
  action: "tabAction",
  unread: "tabUnread",
  all: "tabAll",
  archived: "tabArchived",
};

/** The unread count, and a red dot while critical work stays open for an ADMIN (KEHOACH 9.21.4). */
export function useNoticeCounts() {
  const signedIn = useSession((s) => s.accessToken !== null);
  return useQuery({
    queryKey: [...NOTICES_KEY, "counts"],
    enabled: signedIn,
    refetchInterval: kPollMs,
    queryFn: async () => (await api.get<NoticeCounts>("/notifications/counts")).data,
  });
}

function Counted({ counts, children }: { counts: NoticeCounts | undefined; children: ReactNode }) {
  const t = useTranslations("notices");
  const unread = counts?.unread ?? 0;
  return (
    <span className="relative">
      {children}
      {unread > 0 ? (
        <Badge variant="warning" className="pointer-events-none absolute -top-1 -right-1 px-1.5 tabular-nums">
          {unread > kMaxShown ? `${kMaxShown}+` : unread}
        </Badge>
      ) : null}
      {(counts?.critical ?? 0) > 0 ? (
        <span
          role="img"
          aria-label={t("criticalOpen")}
          className="pointer-events-none absolute -bottom-0.5 -left-0.5 size-2.5 rounded-full bg-kumo-danger ring-2 ring-kumo-base"
        />
      ) : null}
    </span>
  );
}

export function NoticeBell() {
  const t = useTranslations("notices");
  const counts = useNoticeCounts();
  const marks = useNoticeMarks();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<NoticeStatus | null>(null);
  // Until the reader picks a tab, the first with something in it, read off the counts as they arrive.
  const tab = picked ?? ((counts.data?.action ?? 0) > 0 ? "action" : (counts.data?.unread ?? 0) > 0 ? "unread" : "all");

  function toggle(next: boolean): void {
    if (next) {
      setPicked(null);
    }
    setOpen(next);
  }

  const counted = (status: NoticeStatus) => (status === "action" ? counts.data?.action : status === "unread" ? counts.data?.unread : undefined);

  return (
    <>
      <span className="md:hidden">
        <Counted counts={counts.data}>
          <LinkButton href="/notifications" variant="ghost" shape="square" icon={BellIcon} aria-label={t("title")} />
        </Counted>
      </span>
      <span className="hidden md:inline-flex">
        <Popover open={open} onOpenChange={toggle}>
          <Counted counts={counts.data}>
            <Popover.Trigger render={<Button variant="ghost" shape="square" icon={BellIcon} aria-label={t("title")} />} />
          </Counted>
          <Popover.Content className="w-[25rem] p-0">
            <div className="flex flex-col gap-2.5 border-b border-kumo-hairline px-4 py-3">
              <Popover.Title>{t("title")}</Popover.Title>
              <Tabs
                variant="segmented"
                size="sm"
                value={tab}
                onValueChange={(next) => setPicked(next as NoticeStatus)}
                tabs={TABS.map((status) => ({
                  value: status,
                  label: (
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                      {t(TAB_KEY[status])}
                      {counted(status) ? <span className="tabular-nums text-kumo-subtle">{counted(status)}</span> : null}
                    </span>
                  ),
                }))}
              />
            </div>
            <NoticeList status={tab} onGo={() => setOpen(false)} />
            <div className="flex items-center justify-between gap-2 border-t border-kumo-hairline px-2 py-2">
              {(counts.data?.unread ?? 0) > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={marks.isPending}
                  onClick={() => marks.mutate({ action: "read", filter: { status: tab } })}
                >
                  {t("markAll")}
                </Button>
              ) : (
                <span />
              )}
              <Link href={`/notifications?tab=${tab}`} className="px-2 text-kumo-link hover:underline" onClick={() => setOpen(false)}>
                {t("seeAll")}
              </Link>
            </div>
          </Popover.Content>
        </Popover>
      </span>
    </>
  );
}
