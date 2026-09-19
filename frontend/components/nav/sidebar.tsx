"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { Link, usePathname } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { navFor } from "@/lib/nav";

const DECIDERS = ["MANAGER", "ADMIN", "HR"];

export function Sidebar({ onSignOut }: { onSignOut: () => void }) {
  const t = useTranslations("nav");
  const app = useTranslations("app");
  const here = usePathname();
  const { role } = useSession();
  const groups = navFor(role);

  const waiting = useQuery({
    queryKey: ["requests", "inbox", "count"],
    enabled: role !== null && DECIDERS.includes(role),
    refetchInterval: 60_000,
    queryFn: async () =>
      (await api.get<{ total: number }>("/requests/inbox?take=1")).data.total,
  });

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-(--color-line) bg-(--color-surface) p-3">
      <p className="px-2 pt-1 text-sm font-semibold">{app("name")}</p>
      <p className="px-2 pb-4 text-xs text-(--color-muted)">{role}</p>

      <nav className="flex flex-1 flex-col gap-4 overflow-y-auto">
        {groups.map((group) => (
          <div key={group.key}>
            <p className="px-2 pb-1 text-[11px] font-medium tracking-wide text-(--color-muted) uppercase">
              {t(group.key)}
            </p>
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={here === item.href ? "page" : undefined}
                  className={cn(
                    "flex items-center justify-between rounded-lg px-2 py-2 text-sm",
                    here === item.href
                      ? "bg-(--color-accent) text-white"
                      : "hover:bg-(--color-ground)",
                  )}
                >
                  <span>{t(item.key)}</span>
                  {item.badge === "approvals" && (waiting.data ?? 0) > 0 ? (
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-[11px] tabular-nums",
                        here === item.href
                          ? "bg-white/20"
                          : "bg-(--color-warn) text-white",
                      )}
                    >
                      {waiting.data}
                    </span>
                  ) : null}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <button
        onClick={onSignOut}
        className="mt-4 w-full rounded-lg px-2 py-2 text-left text-sm text-(--color-muted) hover:bg-(--color-ground)"
      >
        {t("signOut")}
      </button>
    </aside>
  );
}
