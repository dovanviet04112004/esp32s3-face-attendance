"use client";

import { Button } from "@cloudflare/kumo";
import { ArchiveIcon, ArrowCounterClockwiseIcon, ChecksIcon, EnvelopeOpenIcon, EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Suspense, useEffect, useMemo, useState } from "react";

import { useNoticeCounts } from "@/components/notifications/bell";
import { NOTICE_CATEGORIES, NOTICE_LOOK, type Notice } from "@/components/notifications/kinds";
import {
  NOTICES_KEY,
  NoticeLine,
  useNoticeActions,
  useNoticeMarks,
  useNoticeWords,
  type MarkAction,
  type NoticeFilter,
  type NoticeStatus,
} from "@/components/notifications/notice-row";
import { DataTable, type Column } from "@/components/tables/data-table";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { PageHeader, PageLayout } from "@/components/ui/page";
import { CountPill, StatePill } from "@/components/ui/pill";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useUrlState } from "@/lib/url-state";

const STATUSES: NoticeStatus[] = ["action", "unread", "all", "archived"];
const kPage = 50;

const TAB_KEY: Record<NoticeStatus, "tabAction" | "tabUnread" | "tabAll" | "tabArchived"> = {
  action: "tabAction",
  unread: "tabUnread",
  all: "tabAll",
  archived: "tabArchived",
};

const EMPTY_KEY: Record<NoticeStatus, "emptyAction" | "emptyUnread" | "empty" | "emptyArchived"> = {
  action: "emptyAction",
  unread: "emptyUnread",
  all: "empty",
  archived: "emptyArchived",
};

interface NoticePage {
  rows: Notice[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
}

function queryOf(params: Record<string, string>): string {
  const kept = Object.entries(params).filter(([, value]) => value !== "");
  return kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
}

function Notifications() {
  const t = useTranslations("notices");
  const router = useRouter();
  const say = useNoticeWords();
  const counts = useNoticeCounts();
  const marks = useNoticeMarks();
  const actionsOf = useNoticeActions();
  const [url, setUrl] = useUrlState({ tab: "", q: "", category: "", from: "", to: "" });
  const [typed, setTyped] = useState(url.q);
  const settled = useSettled(typed.trim());
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (settled !== url.q) {
      setUrl({ q: settled });
    }
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps

  const fallback: NoticeStatus = (counts.data?.action ?? 0) > 0 ? "action" : "all";
  const tab = (STATUSES as string[]).includes(url.tab) ? (url.tab as NoticeStatus) : fallback;
  const filter: NoticeFilter = useMemo(
    () => ({ status: tab, category: url.category, from: url.from, to: url.to, search: url.q }),
    [tab, url.category, url.from, url.to, url.q],
  );
  const filtering = url.q !== "" || url.category !== "" || url.from !== "" || url.to !== "";

  useEffect(() => setChosen(new Set()), [filter]);

  const notices = useInfiniteQuery({
    queryKey: [...NOTICES_KEY, "page", filter],
    initialPageParam: "",
    queryFn: async ({ pageParam }) =>
      (
        await api.get<NoticePage>(
          `/notifications${queryOf({ status: tab, category: url.category, from: url.from, to: url.to, search: url.q, take: String(kPage), cursor: pageParam })}`,
        )
      ).data,
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const loaded = notices.data?.pages.flatMap((one) => one.rows);
  const first = notices.data?.pages[0];
  const counted = (status: NoticeStatus) => (status === "action" ? counts.data?.action : status === "unread" ? counts.data?.unread : undefined);

  function open(notice: Notice): void {
    if (notice.readAt === null) {
      marks.mutate({ action: "read", ids: [notice.id], quiet: true });
    }
    const where = NOTICE_LOOK[notice.kind].path(notice);
    if (where !== null) {
      router.push(where);
    }
  }

  function markChosen(action: MarkAction, rows: Notice[]): void {
    marks.mutate({ action, ids: rows.map((row) => row.id) }, { onSuccess: () => setChosen(new Set()) });
  }

  const columns: Column<Notice>[] = [
    {
      id: "notice",
      header: t("colNotice"),
      cell: (row) => <NoticeLine notice={row} state="phone" />,
      card: (row) => say.sentence(row),
    },
    {
      id: "state",
      header: t("colState"),
      priority: 2,
      cell: (row) => {
        const where = say.state(row);
        return where ? <StatePill tone={where.tone}>{where.label}</StatePill> : null;
      },
    },
  ];

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("pageLead")}
        meta={counts.data && counts.data.unread > 0 ? <CountPill>{counts.data.unread}</CountPill> : undefined}
        actions={
          (counts.data?.unread ?? 0) > 0 ? (
            <Button icon={ChecksIcon} loading={marks.isPending && marks.variables?.ids === undefined} onClick={() => marks.mutate({ action: "read", filter })}>
              {t("markAll")}
            </Button>
          ) : undefined
        }
        tabs={STATUSES.map((status) => ({
          value: status,
          label: (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              {t(TAB_KEY[status])}
              {counted(status) ? <CountPill>{counted(status)}</CountPill> : null}
            </span>
          ),
        }))}
        tab={tab}
        onTab={(next) => setUrl({ tab: next })}
      />

      <PageLayout>
        <FilterBar
          search={{ value: typed, onChange: setTyped, placeholder: t("searchHint") }}
          filters={[
            {
              key: "category",
              label: t("category"),
              value: url.category,
              onChange: (next) => setUrl({ category: next }),
              items: { "": t("anyCategory"), ...Object.fromEntries(NOTICE_CATEGORIES.map((one) => [one, t(`category${one}`)])) },
            },
          ]}
          range={{ from: url.from, to: url.to, onFrom: (next) => setUrl({ from: next }), onTo: (next) => setUrl({ to: next }) }}
        />
        <DataTable
          id="notifications"
          columns={columns}
          cardLead="notice"
          rows={loaded}
          keyOf={(row) => row.id}
          pending={notices.isPending}
          failed={notices.isError}
          onRetry={() => void notices.refetch()}
          onRowClick={open}
          rowActions={actionsOf}
          empty={filtering ? t("noMatch") : t(EMPTY_KEY[tab])}
          selectable
          chosen={chosen}
          onChosenChange={setChosen}
          bulk={(rows) => (
            <>
              <Button size="sm" variant="secondary" icon={EnvelopeOpenIcon} onClick={() => markChosen("read", rows)}>
                {t("markRead")}
              </Button>
              <Button size="sm" variant="secondary" icon={EnvelopeSimpleIcon} onClick={() => markChosen("unread", rows)}>
                {t("markUnread")}
              </Button>
              {tab === "archived" ? (
                <Button size="sm" variant="secondary" icon={ArrowCounterClockwiseIcon} onClick={() => markChosen("unarchive", rows)}>
                  {t("unarchive")}
                </Button>
              ) : (
                <Button size="sm" variant="secondary" icon={ArchiveIcon} onClick={() => markChosen("archive", rows)}>
                  {t("archive")}
                </Button>
              )}
            </>
          )}
          paging={
            first
              ? {
                  shown: loaded?.length ?? 0,
                  total: first.total,
                  exact: first.totalIsExact,
                  onMore: notices.hasNextPage ? () => void notices.fetchNextPage() : undefined,
                  loading: notices.isFetchingNextPage,
                }
              : undefined
          }
        />
      </PageLayout>
    </>
  );
}

// The tab and the filters ride on the query string, which the prerender does not have.
export default function NotificationsPage() {
  return (
    <Suspense>
      <Notifications />
    </Suspense>
  );
}
