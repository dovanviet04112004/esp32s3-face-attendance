"use client";

import { useIsFetching } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { usePathname, useRouter } from "@/i18n/navigation";

/** A list's search, filters and sort in the query string, so Back and a shared link reopen the view (KEHOACH 9.12).
 *  Defaults stay off the URL, other params stay on. The search box keeps its typed text and writes
 *  useSettled(typed), never each keystroke. A prerendered page wraps the reader in <Suspense> (Next 16).
 */
export function useUrlState<T extends Record<string, string>>(defaults: T): [T, (patch: Partial<T>) => void] {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const query = params.toString();
  const signature = JSON.stringify(defaults);
  const pending = useRef<string | null>(null);

  useEffect(() => {
    pending.current = null;
  }, [query]);

  const state = useMemo(() => {
    const held = new URLSearchParams(query);
    const base = JSON.parse(signature) as T;
    return Object.fromEntries(Object.entries(base).map(([key, fallback]) => [key, held.get(key) ?? fallback])) as T;
  }, [query, signature]);

  const patch = useCallback(
    (change: Partial<T>) => {
      const base = JSON.parse(signature) as T;
      const next = new URLSearchParams(pending.current ?? query);
      for (const [key, value] of Object.entries(change)) {
        if (value === undefined || value === base[key]) {
          next.delete(key);
        } else {
          next.set(key, value);
        }
      }
      const text = next.toString();
      pending.current = text;
      router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false });
    },
    [query, signature, pathname, router],
  );

  return [state, patch];
}

/** Scrolls to the element `?focus=` names once `ready` and every read in flight has landed, then drops the param.
 *  A `?who=` beside it names the list a notice opens there: it goes to `open` and is dropped too (KEHOACH 9.21.4).
 */
export function useFocusOnArrival(ready: boolean, open?: (who: string) => void): void {
  const pathname = usePathname();
  const router = useRouter();
  const fetching = useIsFetching();
  const opener = useRef(open);
  useEffect(() => {
    opener.current = open;
  });
  useEffect(() => {
    const held = new URLSearchParams(window.location.search);
    const target = held.get("focus");
    if (!target || !ready || fetching > 0) {
      return;
    }
    document.getElementById(target)?.scrollIntoView({ block: "start" });
    const who = held.get("who");
    if (who) {
      opener.current?.(who);
    }
    held.delete("focus");
    held.delete("who");
    const rest = held.toString();
    router.replace(rest ? `${pathname}?${rest}` : pathname, { scroll: false });
  }, [ready, fetching, pathname, router]);
}
