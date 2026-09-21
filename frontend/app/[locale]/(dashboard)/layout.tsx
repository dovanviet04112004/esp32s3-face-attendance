"use client";

import { useTranslations } from "next-intl";
import { useEffect, type ReactNode } from "react";

import { Sidebar } from "@/components/nav/sidebar";
import { TabBar } from "@/components/nav/tab-bar";
import { TopBar } from "@/components/nav/top-bar";
import { usePathname, useRouter } from "@/i18n/navigation";
import { reopenSession } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { allows, homeFor } from "@/lib/nav";
import { startOutbox } from "@/lib/outbox";


export default function DashboardLayout({ children }: { children: ReactNode }) {
  const t = useTranslations("nav");
  const router = useRouter();
  const here = usePathname();
  const { accessToken, role, employeeId, clear } = useSession();
  const hasRecord = employeeId !== null;

  useEffect(() => {
    startOutbox();
  }, []);

  useEffect(() => {
    if (accessToken) {
      return;
    }
    // A reload empties the store but not the refresh cookie, so the cookie
    // gets one chance and the login form is the fallback.
    void reopenSession().then((token) => {
      if (!token) {
        router.replace("/login");
      }
    });
  }, [accessToken, router]);

  // The sidebar hides what a role cannot use, but the address bar keeps the
  // last one: signing in as a narrower role leaves it standing there (9.15).
  useEffect(() => {
    if (!accessToken || allows(role, hasRecord, here)) {
      return;
    }
    router.replace(homeFor(role, hasRecord));
  }, [accessToken, role, hasRecord, here, router]);

  if (!accessToken) {
    return <main className="grid min-h-screen place-items-center text-sm">{t("opening")}</main>;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="flex-1 p-4 pb-24 md:p-8 md:pb-8">
          <div className="mx-auto w-full max-w-(--width-shell)">{children}</div>
        </main>
      </div>
      <TabBar />
    </div>
  );
}
