"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/** A page's primary action, held against the bottom edge of a phone where a
 *  thumb reaches and left in the flow on a desk (KEHOACH 9.21.2). */
export function BottomBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "sticky bottom-0 z-20 -mx-4 mt-4 flex flex-wrap items-center gap-2 border-t border-(--color-line) bg-(--color-surface) px-4 py-3",
        "pb-[max(0.75rem,env(safe-area-inset-bottom))] md:static md:z-auto md:mx-0 md:border-0 md:bg-transparent md:px-0 md:pb-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
