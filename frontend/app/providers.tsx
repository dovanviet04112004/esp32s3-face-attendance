"use client";

import { KumoLocaleProvider, LinkProvider, Toasty, type LinkComponentProps } from "@cloudflare/kumo";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { forwardRef, useEffect, useState, type ReactNode } from "react";

import { toasts, useNotify } from "@/components/ui/notify";
import { Link } from "@/i18n/navigation";
import { isProduction } from "@/lib/env";

const STALE_MS = 30_000;

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

// Kumo renders its own links; this keeps them on the locale-aware router.
const RouterLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(function RouterLink(
  { href, to: _to, ...rest },
  ref,
) {
  return <Link ref={ref} href={href ?? "/"} {...rest} />;
});

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(clientForSession);
  const common = useTranslations("common");
  const { failed } = useNotify();
  useEffect(() => {
    unhandled = failed;
  }, [failed]);

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
          <Toasty toastManager={toasts}>{children}</Toasty>
        </LinkProvider>
      </KumoLocaleProvider>
    </QueryClientProvider>
  );
}
