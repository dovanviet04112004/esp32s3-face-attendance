"use client";

import { Badge, Button, Popover } from "@cloudflare/kumo";
import { BellIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { NoticeList } from "./notice-list";

const kPollMs = 60_000;
const kMaxShown = 9;

export function NoticeBell() {
  const t = useTranslations("notices");
  const signedIn = useSession((s) => s.accessToken !== null);
  const [open, setOpen] = useState(false);

  const unread = useQuery({
    queryKey: ["notifications", "unread"],
    enabled: signedIn,
    refetchInterval: kPollMs,
    queryFn: async () => (await api.get<{ total: number }>("/notifications/unread")).data.total,
  });

  const waiting = unread.data ?? 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span className="relative">
        <Popover.Trigger render={<Button variant="ghost" shape="square" icon={BellIcon} aria-label={t("title")} />} />
        {waiting > 0 ? (
          <Badge variant="warning" className="pointer-events-none absolute -top-1 -right-1 px-1.5 tabular-nums">
            {waiting > kMaxShown ? `${kMaxShown}+` : waiting}
          </Badge>
        ) : null}
      </span>
      <Popover.Content className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <div className="border-b border-kumo-hairline px-4 py-3">
          <Popover.Title>{t("title")}</Popover.Title>
        </div>
        <NoticeList onGo={() => setOpen(false)} />
      </Popover.Content>
    </Popover>
  );
}
