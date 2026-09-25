"use client";

import { Sidebar as KumoSidebar } from "@cloudflare/kumo";
import { useTranslations } from "next-intl";

import { usePathname } from "@/i18n/navigation";
import { useSession } from "@/lib/auth";
import { entriesFor, entryOf } from "@/lib/nav";
import { useWaitingCount } from "./waiting-count";

export function Sidebar() {
  const t = useTranslations("nav");
  const app = useTranslations("app");
  const roleName = useTranslations("roles");
  const here = usePathname();
  const { role, employeeId } = useSession();
  const groups = entriesFor(role, employeeId !== null);
  const waiting = useWaitingCount(role);
  // A detail page or a section tab belongs to the entry that owns it, so that entry stays lit.
  const current = entryOf(groups, here)?.href;

  return (
    // The rail pins itself while the window scrolls; below md Kumo draws a sheet placed on its own.
    <KumoSidebar className="md:sticky md:top-0 md:h-svh md:self-start">
      <KumoSidebar.Header>
        <img src="/logo.svg" alt="" width={24} height={24} className="shrink-0" />
        <div className="min-w-0 ps-2 group-data-[state=collapsed]/sidebar:hidden">
          <p className="truncate text-base font-semibold">{app("name")}</p>
          <p className="truncate text-sm text-kumo-subtle">{role ? roleName(role) : null}</p>
        </div>
      </KumoSidebar.Header>

      <KumoSidebar.Content>
        {groups.map((group) => (
          <KumoSidebar.Group key={group.key}>
            <KumoSidebar.GroupLabel>{t(group.key)}</KumoSidebar.GroupLabel>
            <KumoSidebar.Menu>
              {group.entries.map((entry) => (
                <KumoSidebar.MenuItem key={entry.href}>
                  <KumoSidebar.MenuButton
                    icon={entry.icon}
                    href={entry.href}
                    active={current === entry.href}
                    tooltip={t(entry.key)}
                  >
                    <span className="flex-1 truncate">{t(entry.key)}</span>
                    {entry.badge === "approvals" && waiting > 0 ? (
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
