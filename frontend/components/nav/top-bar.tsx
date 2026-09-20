"use client";

import { LogOut, Settings } from "lucide-react";
import { useTranslations } from "next-intl";

import { NoticeBell } from "@/components/notifications/bell";
import { GlobalSearch } from "@/components/search/global-search";
import { Link } from "@/i18n/navigation";

export function TopBar({ onSignOut }: { onSignOut: () => void }) {
  const t = useTranslations("nav");
  const app = useTranslations("app");

  return (
    <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-(--color-line) bg-(--color-surface) px-3 py-2">
      <img src="/logo.svg" alt="" width={22} height={22} className="md:hidden" />
      <p className="truncate text-sm font-semibold md:hidden">{app("name")}</p>
      <div className="min-w-0 flex-1 md:max-w-lg">
        <GlobalSearch />
      </div>
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
