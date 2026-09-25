"use client";

import { Sidebar as KumoSidebar, SkeletonLine } from "@cloudflare/kumo";
import { useTranslations } from "next-intl";
import { useEffect, type ReactNode } from "react";

import { SectionBar } from "@/components/nav/section-bar";
import { Sidebar } from "@/components/nav/sidebar";
import { TabBar } from "@/components/nav/tab-bar";
import { TopBar } from "@/components/nav/top-bar";
import { usePathname, useRouter } from "@/i18n/navigation";
import { reopenSession } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { allows, homeFor, ownerOf } from "@/lib/nav";
import { startOutbox } from "@/lib/outbox";
import { useFeedConnection } from "@/lib/ws";

const kFrame = "bg-kumo-canvas [--sidebar-bg:var(--color-kumo-canvas)]";
const kBlock = "mx-auto w-full max-w-(--width-shell) px-6 pt-6 pb-24 md:px-8 md:py-8 lg:px-10 lg:py-9";

/** The frame as it will be, drawn in skeleton while the refresh cookie buys a session back. */
function Opening() {
  const t = useTranslations("nav");
  const app = useTranslations("app");
  return (
    <KumoSidebar.Provider className={kFrame}>
      <KumoSidebar className="md:sticky md:top-0 md:h-svh md:self-start">
        <KumoSidebar.Header>
          <img src="/logo.svg" alt="" width={24} height={24} className="shrink-0" />
          <p className="min-w-0 truncate ps-2 text-base font-semibold group-data-[state=collapsed]/sidebar:hidden">{app("name")}</p>
        </KumoSidebar.Header>
        <KumoSidebar.Content>
          <KumoSidebar.Loading label={t("opening")} />
        </KumoSidebar.Content>
      </KumoSidebar>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[58px] items-center gap-3 border-b border-kumo-line bg-kumo-canvas px-4">
          <img src="/logo.svg" alt="" width={22} height={22} className="shrink-0 md:hidden" />
          <SkeletonLine minWidth={12} maxWidth={20} className="hidden md:block" />
          <SkeletonLine minWidth={18} maxWidth={26} className="ms-auto" />
        </header>
        <main aria-busy className="flex-1">
          <div className={kBlock}>
            <div className="flex flex-col gap-3">
              <SkeletonLine minWidth={25} maxWidth={40} blockHeight={28} />
              <SkeletonLine minWidth={40} maxWidth={60} />
            </div>
            <div className="mt-8 flex flex-col gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line">
              {Array.from({ length: 6 }, (_, at) => (
                <SkeletonLine key={at} minWidth={50} maxWidth={100} />
              ))}
            </div>
          </div>
        </main>
      </div>
    </KumoSidebar.Provider>
  );
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const t = useTranslations("nav");
  const app = useTranslations("app");
  const router = useRouter();
  const here = usePathname();
  const { accessToken, role, employeeId } = useSession();
  const hasRecord = employeeId !== null;
  useFeedConnection();

  useEffect(() => {
    startOutbox();
  }, []);

  const owner = ownerOf(here);
  // The tab, the history entry and the bookmark read this, off the same table
  // the sidebar lights up (KEHOACH 9.15).
  const tab = owner ? `${t(owner.key)} · ${app("name")}` : app("name");

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
    return <Opening />;
  }

  return (
    // Kumo's chrome is one colour with the page; cards and tables are the lifted surface (KEHOACH 9.12).
    <KumoSidebar.Provider className={kFrame}>
      <title>{tab}</title>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-kumo-brand focus:px-4 focus:py-2 focus:text-base focus:text-white"
      >
        {t("skip")}
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <SectionBar />
        <main id="main" className="flex-1">
          <div className={kBlock}>
            {children}
          </div>
        </main>
      </div>
      <TabBar />
    </KumoSidebar.Provider>
  );
}
