"use client";

import { useQuery } from "@tanstack/react-query";
import { BellIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Sheet } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { NoticeList } from "./notice-list";

const kPollMs = 60_000;
const kMaxShown = 9;

export function NoticeBell() {
  const t = useTranslations("notices");
  const common = useTranslations("common");
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
    <>
      <button
        type="button"
        aria-label={t("title")}
        onClick={() => setOpen(true)}
        className="relative grid size-11 shrink-0 place-items-center rounded-lg text-(--color-muted) hover:bg-(--color-ground)"
      >
        <BellIcon className="size-5" aria-hidden />
        {waiting > 0 ? (
          <span
            className={cn(
              "absolute top-1 right-1 min-w-4 rounded-full bg-(--color-warn) px-1",
              "text-[10px] leading-4 text-(--color-on-fill) tabular-nums",
            )}
          >
            {waiting > kMaxShown ? `${kMaxShown}+` : waiting}
          </span>
        ) : null}
      </button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={t("title")}
        closeLabel={common("close")}
      >
        <NoticeList onGo={() => setOpen(false)} />
      </Sheet>
    </>
  );
}
