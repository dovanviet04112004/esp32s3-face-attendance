"use client";

import { Badge, LinkButton } from "@cloudflare/kumo";
import { TrayIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";

import { NoticeBell } from "@/components/notifications/bell";
import { GlobalSearch } from "@/components/search/global-search";
import { Link } from "@/i18n/navigation";
import { useSession } from "@/lib/auth";
import { homeFor, navFor } from "@/lib/nav";
import { AccountMenu } from "./account-menu";
import { Breadcrumb } from "./breadcrumb";
import { useWaitingCount } from "./waiting-count";

/** Kumo's product header: the trail at the left edge, the tools at the right. */
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
    // 58 px with its border plus the status bar an installed app draws under, as Sidebar.Header, so the lines meet.
    <header className="sticky top-0 z-30 flex h-[calc(58px+env(safe-area-inset-top))] [view-transition-name:top-bar] items-center gap-2 border-b border-kumo-line bg-kumo-canvas px-4 pt-[env(safe-area-inset-top)]">
      <Link
        href={homeFor(role, employeeId !== null)}
        aria-label={app("name")}
        className="shrink-0 rounded-md motion-press focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:outline-none md:hidden"
      >
        <img src="/logo.svg" alt="" width={22} height={22} className="block" />
      </Link>
      <div className="hidden min-w-0 flex-1 md:flex">
        <Breadcrumb />
      </div>
      <div className="min-w-0 flex-1 md:w-72 md:flex-none lg:w-80">
        <GlobalSearch />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {decides ? (
          <span className="relative">
            <LinkButton
              href="/approvals"
              variant="ghost"
              shape="square"
              icon={TrayIcon}
              aria-label={t("approvals")}
            />
            {waiting > 0 ? (
              <Badge variant="warning" className="pointer-events-none absolute -top-1 -right-1 px-1.5 tabular-nums">
                {waiting}
              </Badge>
            ) : null}
          </span>
        ) : null}
        <NoticeBell />
        <AccountMenu />
      </div>
    </header>
  );
}
