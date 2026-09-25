"use client";

import { Sidebar as KumoSidebar } from "@cloudflare/kumo";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  ViewTransition,
  type ReactNode,
} from "react";

import { useSidebarSeed } from "@/app/providers";
import { SectionBar } from "@/components/nav/section-bar";
import { Sidebar } from "@/components/nav/sidebar";
import { TabBar } from "@/components/nav/tab-bar";
import { TopBar } from "@/components/nav/top-bar";
import { SkeletonLine } from "@/components/ui/skeleton";
import { usePathname, useRouter } from "@/i18n/navigation";
import { reopenSession } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { allows, homeFor, namesItself, ownerOf } from "@/lib/nav";
import { startOutbox } from "@/lib/outbox";
import { rememberSidebar } from "@/lib/theme";
import { useFeedConnection } from "@/lib/ws";

const kFrame = "bg-kumo-canvas [--sidebar-bg:var(--color-kumo-canvas)]";
const kBlock = "mx-auto w-full max-w-(--width-shell) px-6 pt-6 pb-24 md:px-8 md:py-8 lg:px-10 lg:py-9";
// Kumo's own breakpoint: below it the rail is a sheet, which the tab bar replaces (KEHOACH 9.21.1).
const kDesk = "(min-width: 48rem)";

interface Rail {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function listenDesk(again: () => void): () => void {
  const query = window.matchMedia(kDesk);
  query.addEventListener("change", again);
  return () => query.removeEventListener("change", again);
}

/** Collapsed or open as the reader left it, the cookie carrying it across reloads (KEHOACH 9.12). */
function useRail(): Rail {
  const seed = useSidebarSeed();
  const [open, setOpen] = useState(seed);
  const desk = useSyncExternalStore(listenDesk, () => window.matchMedia(kDesk).matches, () => true);
  const onOpenChange = useCallback(
    (next: boolean) => {
      if (desk) {
        setOpen(next);
        rememberSidebar(next);
      }
    },
    [desk],
  );
  return { open: desk && open, onOpenChange };
}

type Move = "drill" | "rise" | "swap";

/** Into a record, back out of one, or across: the phone slides the first two (KEHOACH 9.21.6). */
function moveBetween(from: string, to: string): Move | null {
  if (from === to) {
    return null;
  }
  if (namesItself(to) && !namesItself(from)) {
    return "drill";
  }
  return namesItself(from) && !namesItself(to) ? "rise" : "swap";
}

/** The move this render makes against the committed path; a filter written to the query string
 *  keeps the path and moves nothing. */
function useMove(here: string): Move | null {
  const shown = useRef(here);
  useLayoutEffect(() => {
    shown.current = here;
  }, [here]);
  return moveBetween(shown.current, here);
}

const RAIL_GROUPS = [
  ["w-28", "w-40", "w-24"],
  ["w-24", "w-36", "w-32"],
];

/** Kumo's Sidebar.Loading drawn with our SkeletonLine, whose widths hold between server and browser. */
function RailLoading({ label }: { label: string }) {
  return (
    <div data-sidebar="loading" role="status" aria-label={label} className="flex min-h-0 w-full flex-1 flex-col gap-4 px-2 py-3">
      {RAIL_GROUPS.map((widths, group) => (
        <div key={group} className="flex flex-col gap-0.5">
          <SkeletonLine className="mb-1 ml-2 h-2 w-16 rounded-full group-data-[state=collapsed]/sidebar:hidden" />
          {widths.map((width, item) => (
            <div
              key={item}
              className="flex min-h-8.5 items-center gap-3 rounded-lg px-3 group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:px-0"
            >
              <SkeletonLine className="size-4.5 shrink-0 rounded-md" />
              <SkeletonLine className={`h-2.5 rounded-full group-data-[state=collapsed]/sidebar:hidden ${width}`} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The frame as it will be, drawn in skeleton while the refresh cookie buys a session back. */
function Opening({ rail }: { rail: Rail }) {
  const t = useTranslations("nav");
  const app = useTranslations("app");
  return (
    <KumoSidebar.Provider className={kFrame} peekable {...rail}>
      <KumoSidebar className="md:sticky md:top-0 md:z-40 md:h-svh md:self-start">
        <KumoSidebar.Header className="h-[calc(58px+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]">
          <img src="/logo.svg" alt="" width={24} height={24} className="shrink-0" />
          <p className="min-w-0 truncate ps-2 text-base font-semibold group-data-[state=collapsed]/sidebar:hidden">{app("name")}</p>
        </KumoSidebar.Header>
        <KumoSidebar.Content>
          <RailLoading label={t("opening")} />
        </KumoSidebar.Content>
      </KumoSidebar>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[calc(58px+env(safe-area-inset-top))] items-center gap-3 border-b border-kumo-line bg-kumo-canvas px-4 pt-[env(safe-area-inset-top)]">
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
  const rail = useRail();
  const move = useMove(here);
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
    return <Opening rail={rail} />;
  }

  return (
    // Kumo's chrome is one colour with the page; cards and tables are the lifted surface (KEHOACH 9.12).
    <KumoSidebar.Provider className={kFrame} peekable {...rail}>
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
          <ViewTransition default={move ? `page-${move}` : "none"}>
            <div className={kBlock}>{children}</div>
          </ViewTransition>
        </main>
      </div>
      <TabBar />
    </KumoSidebar.Provider>
  );
}
