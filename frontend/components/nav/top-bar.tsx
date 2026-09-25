"use client";

import { Badge, Button, LinkButton } from "@cloudflare/kumo";
import { BellIcon, TrayIcon, UserCircleIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";

import { NoticeBell } from "@/components/notifications/bell";
import { GlobalSearch, SearchTrigger } from "@/components/search/global-search";
import { SkeletonLine } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import { useSession } from "@/lib/auth";
import { carriesTray, homeFor } from "@/lib/nav";
import { AccountMenu } from "./account-menu";
import { Breadcrumb } from "./breadcrumb";
import { useWaitingCount } from "./waiting-count";

// 58 px with its border plus the status bar an installed app draws under, as Sidebar.Header, so the lines meet.
const kBar =
  "sticky top-0 z-30 flex h-[calc(58px+env(safe-area-inset-top))] [view-transition-name:top-bar] items-center gap-2 border-b border-kumo-line bg-kumo-canvas px-4 pt-[env(safe-area-inset-top)]";
const kSearch = "min-w-0 flex-1 md:w-72 md:flex-none lg:w-80";
const kTools = "flex shrink-0 items-center gap-1";

/** The bar as it will stand, inert while the session reopens: same boxes, so nothing moves when it swaps. */
export function TopBarLoading({ tray }: { tray: boolean }) {
  const t = useTranslations("nav");
  const notices = useTranslations("notices");
  return (
    <header inert className={kBar}>
      <img src="/logo.svg" alt="" width={22} height={22} fetchPriority="high" className="block shrink-0 md:hidden" />
      <div className="hidden min-w-0 flex-1 md:flex">
        <SkeletonLine minWidth={12} maxWidth={20} />
      </div>
      <div className={kSearch}>
        <SearchTrigger />
      </div>
      <div className={kTools}>
        {tray ? <Button variant="ghost" shape="square" icon={TrayIcon} aria-label={t("approvals")} /> : null}
        <Button variant="ghost" shape="square" icon={BellIcon} aria-label={notices("title")} />
        <Button variant="ghost" shape="square" icon={UserCircleIcon} aria-label={t("account")} />
      </div>
    </header>
  );
}

/** Kumo's product header: the trail at the left edge, the tools at the right. */
export function TopBar() {
  const t = useTranslations("nav");
  const app = useTranslations("app");
  const { role, employeeId } = useSession();
  const waiting = useWaitingCount(role);
  const decides = carriesTray(role, employeeId !== null);

  return (
    <header className={kBar}>
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
      <div className={kSearch}>
        <GlobalSearch />
      </div>
      <div className={kTools}>
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
