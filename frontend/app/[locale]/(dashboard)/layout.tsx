"use client";

import { useTranslations } from "next-intl";
import { useEffect, type ReactNode } from "react";

import { Sidebar } from "@/components/nav/sidebar";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";


export default function DashboardLayout({ children }: { children: ReactNode }) {
  const t = useTranslations("nav");
  const router = useRouter();
  const { accessToken, clear } = useSession();

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
    return <main className="grid min-h-screen place-items-center text-sm">{t("opening")}</main>;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar onSignOut={signOut} />
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
