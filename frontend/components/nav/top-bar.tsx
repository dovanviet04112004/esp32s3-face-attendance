"use client";

import { Inbox, LogOut, Settings } from "lucide-react";
import { useTranslations } from "next-intl";

import { NoticeBell } from "@/components/notifications/bell";
import { GlobalSearch } from "@/components/search/global-search";
import { Link } from "@/i18n/navigation";
import { useSession } from "@/lib/auth";
import { useWaitingCount } from "./waiting-count";

export function TopBar({ onSignOut }: { onSignOut: () => void }) {
  const t = useTranslations("nav");
  const app = useTranslations("app");
  const { role } = useSession();
  const waiting = useWaitingCount(role);
  const decides = role === "MANAGER" || role === "ADMIN" || role === "HR";

  return (
    <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-(--color-line) bg-(--color-surface) px-3 py-2">
      <img src="/logo.svg" alt="" width={22} height={22} className="md:hidden" />
      <p className="truncate text-sm font-semibold md:hidden">{app("name")}</p>
      <div className="min-w-0 flex-1 md:max-w-lg">
        <GlobalSearch />
      </div>
      {decides ? (
        <Link
          href="/approvals"
          aria-label={t("approvals")}
          className="relative grid size-11 shrink-0 place-items-center rounded-lg text-(--color-muted) hover:bg-(--color-ground)"
        >
          <Inbox className="size-5" aria-hidden />
          {waiting > 0 ? (
            <span className="absolute top-1 right-1 min-w-4 rounded-full bg-(--color-warn) px-1 text-[10px] leading-4 text-white tabular-nums">
              {waiting}
            </span>
          ) : null}
        </Link>
      ) : null}
      <NoticeBell />
      <Link
        href="/settings"
        aria-label={t("settings")}
        className="grid size-11 shrink-0 place-items-center rounded-lg text-(--color-muted) hover:bg-(--color-ground) md:hidden"
      >
        <Settings className="size-5" aria-hidden />
      </Link>
      <button
        type="button"
        aria-label={t("signOut")}
        onClick={onSignOut}
        className="grid size-11 shrink-0 place-items-center rounded-lg text-(--color-muted) hover:bg-(--color-ground) md:hidden"
      >
        <LogOut className="size-5" aria-hidden />
      </button>
    </header>
  );
}
