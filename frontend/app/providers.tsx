"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { isProduction } from "@/lib/env";
import { useEffect, useState, type ReactNode } from "react";

const STALE_MS = 30_000;

function build(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: STALE_MS, retry: 1, refetchOnWindowFocus: false },
    },
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

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(clientForSession);
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

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
