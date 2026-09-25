"use client";

import { Sidebar as KumoSidebar, useSidebar } from "@cloudflare/kumo";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";

import { Link, usePathname } from "@/i18n/navigation";
import { useSession } from "@/lib/auth";
import { entriesFor, entryOf, homeFor } from "@/lib/nav";
import { useWaitingCount } from "./waiting-count";

const kPeekOpenMs = 150;
const kPeekCloseMs = 300;

/** Peeks the collapsed rail with Cloudflare's intent delay, and closes it once a page is chosen (KEHOACH 9.12).
 *  Kumo opens and closes on the first pointer crossing, so a brush past the edge flickers.
 */
function usePeekIntent(here: string) {
  const { startPeek, stopPeek } = useSidebar();
  const rail = useRef<HTMLElement>(null);
  const timer = useRef(0);

  useEffect(() => {
    window.clearTimeout(timer.current);
    stopPeek();
  }, [here, stopPeek]);

  useEffect(() => {
    // After a pick the rail stays shut until the pointer has left it.
    let chosen = false;
    const after = (act: () => void, delayMs: number) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(act, delayMs);
    };
    // Read on every event: Kumo swaps the phone sheet for the desk rail after the first paint.
    const inside = (target: EventTarget | null) => target instanceof Node && !!rail.current?.contains(target);
    // React builds enter and leave from the element left behind, so both sides of a crossing are held back.
    const cross = (event: MouseEvent) => {
      const from = event.type === "mouseover" ? event.relatedTarget : event.target;
      const to = event.type === "mouseover" ? event.target : event.relatedTarget;
      if (inside(from) === inside(to)) {
        return;
      }
      event.stopPropagation();
      if (inside(to)) {
        if (!chosen) {
          after(startPeek, kPeekOpenMs);
        }
      } else {
        chosen = false;
        after(stopPeek, kPeekCloseMs);
      }
    };
    const pick = (event: MouseEvent) => {
      if (inside(event.target) && (event.target as Element).closest("a[href]")) {
        chosen = true;
        window.clearTimeout(timer.current);
        stopPeek();
      }
    };
    window.addEventListener("mouseover", cross, true);
    window.addEventListener("mouseout", cross, true);
    window.addEventListener("click", pick, true);
    return () => {
      window.clearTimeout(timer.current);
      window.removeEventListener("mouseover", cross, true);
      window.removeEventListener("mouseout", cross, true);
      window.removeEventListener("click", pick, true);
    };
  }, [startPeek, stopPeek]);

  return rail;
}

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
  const rail = usePeekIntent(here);

  return (
    // The rail pins itself while the window scrolls; below md Kumo draws a sheet placed on its own.
    <KumoSidebar ref={rail} className="md:sticky md:top-0 md:z-40 md:h-svh md:self-start">
      <KumoSidebar.Header className="h-[calc(58px+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]">
        <Link
          href={homeFor(role, employeeId !== null)}
          aria-label={app("name")}
          className="flex min-w-0 flex-1 items-center rounded-md motion-press focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:outline-none"
        >
          <img src="/logo.svg" alt="" width={24} height={24} className="shrink-0" />
          <span className="min-w-0 ps-2 group-data-[state=collapsed]/sidebar:hidden">
            <span className="block truncate text-base font-semibold">{app("name")}</span>
            <span className="block truncate text-sm text-kumo-subtle">{role ? roleName(role) : null}</span>
          </span>
        </Link>
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
