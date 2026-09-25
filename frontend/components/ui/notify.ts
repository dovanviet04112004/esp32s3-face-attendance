"use client";

import { createKumoToastManager } from "@cloudflare/kumo";

import { useFault } from "@/lib/fault";

/** The one toast queue, reachable from query-cache callbacks as well as components. */
export const toasts = createKumoToastManager();

/** Every action ends in one of these two (KEHOACH 9.12 rule 5).
 *  @param fell what the mutation threw; its api code becomes the sentence via lib/fault.
 */
export function useNotify(): { done: (title: string, description?: string) => void; failed: (fell: unknown) => void } {
  const faultOf = useFault();
  return {
    done: (title, description) => void toasts.add({ title, description, variant: "success" }),
    failed: (fell) => void toasts.add({ title: faultOf(fell), variant: "error" }),
  };
}
