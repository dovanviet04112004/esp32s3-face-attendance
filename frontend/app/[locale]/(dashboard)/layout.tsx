"use client";

import { useTranslations } from "next-intl";
import { useEffect, type ReactNode } from "react";

import { Sidebar } from "@/components/nav/sidebar";
import { TabBar } from "@/components/nav/tab-bar";
import { TopBar } from "@/components/nav/top-bar";
import { useRouter } from "@/i18n/navigation";
import { api, reopenSession } from "@/lib/api";
import { useSession } from "@/lib/auth";


export default function DashboardLayout({ children }: { children: ReactNode }) {
  const t = useTranslations("nav");
  const router = useRouter();
  const { accessToken, clear } = useSession();

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

  async function signOut() {
    await api.post("/auth/logout").catch(() => undefined);
    clear();
    router.replace("/login");
  }

  if (!accessToken) {
    return <main className="grid min-h-screen place-items-center text-sm">{t("opening")}</main>;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar onSignOut={signOut} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onSignOut={signOut} />
        <main className="flex-1 p-4 pb-24 md:p-8 md:pb-8">{children}</main>
      </div>
      <TabBar onSignOut={signOut} />
    </div>
  );
}
