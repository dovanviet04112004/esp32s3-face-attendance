"use client";

import { KumoLocaleProvider, LinkProvider, Toasty, type LinkComponentProps } from "@cloudflare/kumo";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { createContext, forwardRef, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";

import { toasts, useNotify } from "@/components/ui/notify";
import { Link } from "@/i18n/navigation";
import { whenSignedOut } from "@/lib/auth";
import { isProduction } from "@/lib/env";
import { followSystem } from "@/lib/theme";

const STALE_MS = 30_000;
// A socket asleep this long may have missed news it cannot replay (KEHOACH 9.21.6).
const AWAY_MS = 60_000;

const SidebarSeed = createContext(true);

/** The rail as the server read it from the cookie, so the first frame draws it where the reader left it. */
export function useSidebarSeed(): boolean {
  return useContext(SidebarSeed);
}

let unhandled: (fell: unknown) => void = () => undefined;

function build(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: STALE_MS, retry: 1, refetchOnWindowFocus: false },
    },
    // A mutation that says nothing on failure still gets a toast (KEHOACH 9.12 rule 5).
    mutationCache: new MutationCache({
      onError: (fell, _vars, _ctx, mutation) => {
        if (!mutation.options.onError) {
          unhandled(fell);
        }
      },
    }),
  });
}

let held: QueryClient | undefined;

// One per browser session: under [locale], a client in state loses its cache.
function clientForSession(): QueryClient {
  if (typeof window === "undefined") {
    return build();
  }
  held ??= build();
  return held;
}

// Kumo renders its own links, some by `href` and some by `to`; both go through the locale router.
const RouterLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(function RouterLink(
  { href, to, ...rest },
  ref,
) {
  return <Link ref={ref} href={href ?? to ?? "/"} {...rest} />;
});

export function Providers({ children, sidebarOpen }: { children: ReactNode; sidebarOpen: boolean }) {
  const [client] = useState(clientForSession);
  const common = useTranslations("common");
  const { failed } = useNotify();
  useEffect(() => {
    unhandled = failed;
  }, [failed]);

  useLayoutEffect(() => followSystem(), []);

  useEffect(() => whenSignedOut(() => client.clear()), [client]);

  useEffect(() => {
    let hiddenAt = 0;
    const flip = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt > 0 && Date.now() - hiddenAt > AWAY_MS) {
        void client.invalidateQueries();
      }
      hiddenAt = 0;
    };
    document.addEventListener("visibilitychange", flip);
    return () => document.removeEventListener("visibilitychange", flip);
  }, [client]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }
    if (!isProduction) {
      // A worker an earlier run installed keeps serving its own chunks.
      void navigator.serviceWorker
        .getRegistrations()
        .then((held) => Promise.all(held.map((one) => one.unregister())))
        .then(() => caches?.keys().then((names) => Promise.all(names.map((n) => caches.delete(n)))))
        .catch(() => undefined);
      return;
    }
    const register = () => void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register);
    return () => window.removeEventListener("load", register);
  }, []);

  return (
    <QueryClientProvider client={client}>
      <KumoLocaleProvider translations={{ layerDialog: { close: common("close"), cancel: common("cancel") } }}>
        <LinkProvider component={RouterLink}>
          <SidebarSeed.Provider value={sidebarOpen}>
            <Toasty toastManager={toasts}>{children}</Toasty>
          </SidebarSeed.Provider>
        </LinkProvider>
      </KumoLocaleProvider>
    </QueryClientProvider>
  );
}
