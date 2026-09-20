"use client";

import { useTranslations } from "next-intl";

import { Link, usePathname } from "@/i18n/navigation";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { navFor } from "@/lib/nav";
import { useWaitingCount } from "./waiting-count";

export function Sidebar({ onSignOut }: { onSignOut: () => void }) {
  const t = useTranslations("nav");
  const app = useTranslations("app");
  const here = usePathname();
  const { role } = useSession();
  const groups = navFor(role);
  const waiting = useWaitingCount(role);

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-(--color-line) bg-(--color-surface) p-3 md:flex">
      <div className="flex items-center gap-2 px-2 pt-1">
        <img src="/logo.svg" alt="" width={20} height={20} />
        <p className="text-sm font-semibold">{app("name")}</p>
      </div>
      <p className="px-2 pb-4 text-xs text-(--color-muted)">{role}</p>

      <nav className="flex flex-1 flex-col gap-4 overflow-y-auto">
        {groups.map((group) => (
          <div key={group.key}>
            <p className="px-2 pb-1 text-[11px] font-medium tracking-wide text-(--color-muted) uppercase">
              {t(group.key)}
            </p>
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = here === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-2 py-2 text-sm pointer-coarse:min-h-11",
                      active ? "bg-(--color-accent) text-white" : "hover:bg-(--color-ground)",
                    )}
                  >
                    <Icon
                      className={cn("size-4", active ? "text-white" : "text-(--color-muted)")}
                      aria-hidden
                    />
                    <span className="flex-1">{t(item.key)}</span>
                    {item.badge === "approvals" && waiting > 0 ? (
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0.5 text-[11px] tabular-nums",
                          active ? "bg-white/20" : "bg-(--color-warn) text-white",
                        )}
                      >
                        {waiting}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <button
        onClick={onSignOut}
        className="mt-4 w-full rounded-lg px-2 py-2 text-left text-sm text-(--color-muted) hover:bg-(--color-ground) pointer-coarse:min-h-11"
      >
        {t("signOut")}
      </button>
    </aside>
  );
}
