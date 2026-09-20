"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";

const STALE_MS = 30_000;

export function Providers({ children }: { children: ReactNode }) {
  // Made once per browser session: a client rebuilt on render throws away
  // every cached answer with it.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: STALE_MS, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );
  // Registered after paint so it never delays the first screen.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
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
