"use client";

import { Badge, LayerDialog } from "@cloudflare/kumo";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Link, usePathname } from "@/i18n/navigation";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { entriesFor, entryOf, tabsFor, type NavEntry } from "@/lib/nav";
import { useWaitingCount } from "./waiting-count";

function tabClass(active: boolean): string {
  return cn(
    "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-xs",
    active ? "text-kumo-link" : "text-kumo-subtle",
  );
}

function Count({ waiting }: { waiting: number }) {
  return (
    <Badge variant="warning" className="pointer-events-none absolute -top-1.5 -right-3 px-1.5 tabular-nums">
      {waiting}
    </Badge>
  );
}

function Tab({ entry, active, waiting }: { entry: NavEntry; active: boolean; waiting: number }) {
  const t = useTranslations("nav");
  const Icon = entry.icon;
  return (
    <Link href={entry.href} aria-current={active ? "page" : undefined} className={tabClass(active)}>
      <span className="relative">
        <Icon className="size-5" weight={active ? "fill" : "regular"} aria-hidden />
        {entry.badge === "approvals" && waiting > 0 ? <Count waiting={waiting} /> : null}
      </span>
      <span className="max-w-full truncate">{t(entry.short)}</span>
    </Link>
  );
}

/** The phone's navigation, five slots at the thumb (KEHOACH 9.21.1). */
export function TabBar() {
  const t = useTranslations("nav");
  const here = usePathname();
  const { role, employeeId } = useSession();
  const hasRecord = employeeId !== null;
  const { items, rest } = tabsFor(role, hasRecord);
  const waiting = useWaitingCount(role);
  const [open, setOpen] = useState(false);
  const current = entryOf(entriesFor(role, hasRecord), here)?.href;

  return (
    <>
      <nav
        aria-label={t("primary")}
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-kumo-line bg-kumo-base pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {items.map((entry) => (
          <Tab key={entry.href} entry={entry} active={current === entry.href} waiting={waiting} />
        ))}
        {rest.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={open}
            className={tabClass(rest.some((group) => group.entries.some((entry) => entry.href === current)))}
          >
            <DotsThreeIcon className="size-5" aria-hidden />
            <span>{t("more")}</span>
          </button>
        ) : null}
      </nav>

      <LayerDialog.Root open={open} onOpenChange={setOpen}>
        <LayerDialog.Content closeLabel={t("close")}>
          <LayerDialog.Title>{t("more")}</LayerDialog.Title>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              {rest.map((group) => (
                <div key={group.key}>
                  <p className="pb-1 text-sm font-medium text-kumo-subtle">{t(group.key)}</p>
                  <div className="flex flex-col">
                    {group.entries.map((entry) => {
                      const Icon = entry.icon;
                      return (
                        <Link
                          key={entry.href}
                          href={entry.href}
                          onClick={() => setOpen(false)}
                          aria-current={current === entry.href ? "page" : undefined}
                          className="flex min-h-11 items-center gap-3 rounded-lg px-2 text-base hover:bg-kumo-tint aria-[current=page]:bg-kumo-tint"
                        >
                          <Icon className="size-4 text-kumo-subtle" aria-hidden />
                          <span className="flex-1">{t(entry.key)}</span>
                          {entry.badge === "approvals" && waiting > 0 ? (
                            <Badge variant="warning" className="tabular-nums">
                              {waiting}
                            </Badge>
                          ) : null}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}
