"use client";

import { Ellipsis } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Sheet } from "@/components/ui/sheet";
import { Link, usePathname } from "@/i18n/navigation";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { ownerOf, tabsFor, type NavItem } from "@/lib/nav";
import { useWaitingCount } from "./waiting-count";

function tabClass(active: boolean): string {
  return cn(
    "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px]",
    active ? "text-(--color-accent)" : "text-(--color-muted)",
  );
}

function Tab({ item, active, waiting }: { item: NavItem; active: boolean; waiting: number }) {
  const t = useTranslations("nav");
  const Icon = item.icon;
  return (
    <Link href={item.href} aria-current={active ? "page" : undefined} className={tabClass(active)}>
      <span className="relative">
        <Icon className="size-5" aria-hidden />
        {item.badge === "approvals" && waiting > 0 ? (
          <span className="absolute -top-1 -right-2 min-w-4 rounded-full bg-(--color-warn) px-1 text-[10px] leading-4 text-(--color-on-fill) tabular-nums">
            {waiting}
          </span>
        ) : null}
      </span>
      <span className="truncate">{t(item.key)}</span>
    </Link>
  );
}

export function TabBar() {
  const t = useTranslations("nav");
  const here = usePathname();
  const { role, employeeId } = useSession();
  const { items, rest } = tabsFor(role, employeeId !== null);
  const waiting = useWaitingCount(role);
  const [open, setOpen] = useState(false);
  // A detail page belongs to the entry that owns it, so the tab stays lit.
  const current = ownerOf(here)?.href;

  return (
    <>
      <nav
        aria-label={t("primary")}
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-(--color-line) bg-(--color-surface) pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {items.map((item) => (
          <Tab key={item.href} item={item} active={current === item.href} waiting={waiting} />
        ))}
        {rest.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={open}
            className={tabClass(false)}
          >
            <Ellipsis className="size-5" aria-hidden />
            <span>{t("more")}</span>
          </button>
        ) : null}
      </nav>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={t("more")}
        closeLabel={t("close")}
        className="md:hidden"
      >
        <div className="flex flex-col gap-4">
          {rest.map((group) => (
            <div key={group.key}>
              <p className="pb-1 text-[11px] font-medium tracking-wide text-(--color-muted) uppercase">
                {t(group.key)}
              </p>
              <div className="flex flex-col">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setOpen(false)}
                      className="flex min-h-11 items-center gap-3 rounded-lg px-2 text-sm hover:bg-(--color-ground)"
                    >
                      <Icon className="size-4 text-(--color-muted)" aria-hidden />
                      <span className="flex-1">{t(item.key)}</span>
                      {item.badge === "approvals" && waiting > 0 ? (
                        <span className="rounded-full bg-(--color-warn) px-1.5 text-[11px] text-(--color-on-fill) tabular-nums">
                          {waiting}
                        </span>
                      ) : null}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Sheet>
    </>
  );
}
