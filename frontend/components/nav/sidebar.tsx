"use client";

import { Sidebar as KumoSidebar } from "@cloudflare/kumo";
import { useTranslations } from "next-intl";

import { usePathname } from "@/i18n/navigation";
import { useSession } from "@/lib/auth";
import { navFor, ownerOf } from "@/lib/nav";
import { useWaitingCount } from "./waiting-count";

export function Sidebar() {
  const t = useTranslations("nav");
  const app = useTranslations("app");
  const roleName = useTranslations("roles");
  const here = usePathname();
  const { role, employeeId } = useSession();
  const groups = navFor(role, employeeId !== null);
  const waiting = useWaitingCount(role);
  // A detail page belongs to the entry that owns it, so the trail stays lit.
  const current = ownerOf(here)?.href;

  return (
    // The page scrolls the window, so the rail pins itself to the viewport.
    <KumoSidebar className="sticky top-0 h-svh self-start">
      <KumoSidebar.Header>
        <img src="/logo.svg" alt="" width={24} height={24} className="shrink-0" />
        <div className="min-w-0 ps-2 group-data-[state=collapsed]/sidebar:hidden">
          <p className="truncate text-sm font-semibold">{app("name")}</p>
          <p className="truncate text-xs text-kumo-subtle">{role ? roleName(role) : null}</p>
        </div>
      </KumoSidebar.Header>

      <KumoSidebar.Content>
        {groups.map((group) => (
          <KumoSidebar.Group key={group.key}>
            <KumoSidebar.GroupLabel>{t(group.key)}</KumoSidebar.GroupLabel>
            <KumoSidebar.Menu>
              {group.items.map((item) => (
                <KumoSidebar.MenuItem key={item.href}>
                  <KumoSidebar.MenuButton
                    icon={item.icon}
                    href={item.href}
                    active={current === item.href}
                    tooltip={t(item.key)}
                  >
                    <span className="flex-1 truncate">{t(item.key)}</span>
                    {item.badge === "approvals" && waiting > 0 ? (
                      <KumoSidebar.MenuBadge className="tabular-nums">{waiting}</KumoSidebar.MenuBadge>
                    ) : null}
                  </KumoSidebar.MenuButton>
                </KumoSidebar.MenuItem>
              ))}
            </KumoSidebar.Menu>
          </KumoSidebar.Group>
        ))}
      </KumoSidebar.Content>

      <KumoSidebar.Footer>
        <KumoSidebar.Trigger />
      </KumoSidebar.Footer>
    </KumoSidebar>
  );
}
