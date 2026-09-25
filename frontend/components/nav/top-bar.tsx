"use client";

import { Badge, LinkButton } from "@cloudflare/kumo";
import { TrayIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";

import { NoticeBell } from "@/components/notifications/bell";
import { GlobalSearch } from "@/components/search/global-search";
import { useSession } from "@/lib/auth";
import { navFor } from "@/lib/nav";
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
    // 58 px with its border, the height of Sidebar.Header, so the two lines meet.
    <header className="group/bar sticky top-0 z-30 flex h-[58px] items-center gap-2 border-b border-kumo-line bg-kumo-canvas px-4">
      <img src="/logo.svg" alt={app("name")} width={22} height={22} className="shrink-0 md:hidden" />
      <div className="hidden min-w-0 flex-1 md:flex">
        <Breadcrumb />
      </div>
      <div className="min-w-0 flex-1 md:w-72 md:flex-none lg:w-80">
        <GlobalSearch />
      </div>
      <div className="flex shrink-0 items-center gap-1 group-has-[input:focus]/bar:hidden md:group-has-[input:focus]/bar:flex">
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
