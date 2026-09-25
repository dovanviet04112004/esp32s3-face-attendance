"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/** A page's primary action, where a phone's thumb reaches and in the flow on a desk (KEHOACH 9.21.2). */
export function BottomBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-bottom-bar=""
      className={cn(
        "sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 -mx-6 mt-4 flex flex-wrap items-center gap-2 border-t border-kumo-line bg-kumo-base px-6 py-3",
        "md:static md:z-auto md:mx-0 md:border-0 md:bg-transparent md:px-0 md:py-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
