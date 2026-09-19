"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/auth";

const PAGES = [
  { href: "/overview", label: "Tổng quan" },
  { href: "/employees", label: "Nhân viên" },
  { href: "/attendance", label: "Chấm công" },
  { href: "/devices", label: "Thiết bị" },
  { href: "/shifts", label: "Ca làm" },
  { href: "/reports", label: "Báo cáo" },
] as const;

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const here = usePathname();
  const { accessToken, role, clear } = useSession();

  useEffect(() => {
    if (accessToken) {
      return;
    }
    // A reload empties the store but not the refresh cookie, so one attempt to
    // reopen the session comes first and the login form is the fallback.
    api
      .post("/auth/refresh")
      .catch(() => undefined)
      .finally(() => {
        if (!useSession.getState().accessToken) {
          router.replace("/login");
        }
      });
  }, [accessToken, router]);

  async function signOut() {
    await api.post("/auth/logout").catch(() => undefined);
    clear();
    router.replace("/login");
  }

  if (!accessToken) {
    return <main className="grid min-h-screen place-items-center text-sm">Đang mở phiên…</main>;
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 border-r border-(--color-line) bg-(--color-surface) p-4">
        <p className="px-2 text-sm font-semibold">Chấm công</p>
        <p className="px-2 pb-4 text-xs text-(--color-muted)">{role}</p>
        <nav className="flex flex-col gap-1">
          {PAGES.map((page) => (
            <Link
              key={page.href}
              href={page.href}
              className={cn(
                "rounded-lg px-2 py-2 text-sm",
                here === page.href
                  ? "bg-(--color-accent) text-white"
                  : "hover:bg-(--color-ground)",
              )}
            >
              {page.label}
            </Link>
          ))}
        </nav>
        <button
          onClick={signOut}
          className="mt-6 w-full rounded-lg px-2 py-2 text-left text-sm text-(--color-muted) hover:bg-(--color-ground)"
        >
          Đăng xuất
        </button>
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
