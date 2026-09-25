"use client";

import { GearIcon, TrayIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";

import { NoticeBell } from "@/components/notifications/bell";
import { GlobalSearch } from "@/components/search/global-search";
import { Link } from "@/i18n/navigation";
import { useSession } from "@/lib/auth";
import { navFor } from "@/lib/nav";
import { useWaitingCount } from "./waiting-count";

export function TopBar() {
  const t = useTranslations("nav");
  const app = useTranslations("app");
  const { role, employeeId } = useSession();
  const waiting = useWaitingCount(role);
  // Read off the table, so this icon cannot disagree with the sidebar entry.
  const decides = navFor(role, employeeId !== null).some((group) =>
    group.items.some((item) => item.badge === "approvals"),
  );

  return (
    // The same height as the sidebar header, so the two borders meet in one line.
    <header className="sticky top-0 z-30 border-b border-kumo-line bg-kumo-base">
      <div className="group/bar flex h-[58px] w-full max-w-(--width-shell) items-center gap-2 px-6 md:px-8 lg:px-10">
        <img src="/logo.svg" alt={app("name")} width={22} height={22} className="md:hidden" />
        <div className="min-w-0 flex-1 md:max-w-lg">
          <GlobalSearch />
        </div>

        <div className="ms-auto flex shrink-0 items-center gap-1 group-has-[input:focus]/bar:hidden md:group-has-[input:focus]/bar:flex">
          {decides ? (
            <Link
              href="/approvals"
              aria-label={t("approvals")}
              className="relative grid size-11 place-items-center rounded-lg text-(--color-muted) hover:bg-(--color-ground)"
            >
              <TrayIcon className="size-5" aria-hidden />
              {waiting > 0 ? (
                <span className="absolute top-1 right-1 min-w-4 rounded-full bg-(--color-warn) px-1 text-[10px] leading-4 text-(--color-on-fill) tabular-nums">
                  {waiting}
                </span>
              ) : null}
            </Link>
          ) : null}
          <NoticeBell />
          <Link
            href="/settings"
            aria-label={t("settings")}
            className="grid size-11 place-items-center rounded-lg text-(--color-muted) hover:bg-(--color-ground) md:hidden"
          >
            <GearIcon className="size-5" aria-hidden />
          </Link>
        </div>
      </div>
    </header>
  );
}
