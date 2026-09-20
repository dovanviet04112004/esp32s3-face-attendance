"use client";

import { LogOut } from "lucide-react";
import { useTranslations } from "next-intl";

export function TopBar({ onSignOut }: { onSignOut: () => void }) {
  const t = useTranslations("nav");
  const app = useTranslations("app");

  return (
    <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-(--color-line) bg-(--color-surface) px-3 py-2 md:hidden">
      <p className="flex-1 truncate text-sm font-semibold">{app("name")}</p>
      <button
        type="button"
        aria-label={t("signOut")}
        onClick={onSignOut}
        className="grid size-11 place-items-center rounded-lg text-(--color-muted) hover:bg-(--color-ground)"
      >
        <LogOut className="size-5" aria-hidden />
      </button>
    </header>
  );
}
