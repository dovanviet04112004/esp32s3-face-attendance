"use client";

import { Button, Empty, Loader } from "@cloudflare/kumo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellSimpleIcon } from "@phosphor-icons/react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { useNotify } from "@/components/ui/notify";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { NOTICE_LOOK, type Notice } from "./kinds";

// Relative times need an instant to count from, or the server and the browser
// each pick their own and the two renders disagree.
const kTickMs = 60_000;

/** A notice row: a link where a page says more, otherwise a button that only marks it read. */
function Row({ notice, onRead, onGo, children }: { notice: Notice; onRead: () => void; onGo: () => void; children: ReactNode }) {
  const look = cn(
    "flex min-h-11 w-full items-start gap-3 rounded-md px-2.5 py-2 text-start text-base hover:bg-kumo-tint",
    notice.readAt === null && "bg-kumo-elevated",
  );
  const where = NOTICE_LOOK[notice.kind].path(notice);
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
    const said = NOTICE_LOOK[notice.kind].sentence(notice);
    return said.count === undefined ? t(said.key) : t(said.key, { count: said.count });
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
            const Icon = NOTICE_LOOK[notice.kind].icon;
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
