"use client";

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
