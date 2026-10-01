"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";

interface Foot {
  node: HTMLElement | null;
}

const FootContext = createContext<Foot | null>(null);

/** Gives the page a foot under its column, where a pinned bottom bar lands (KEHOACH 9.12). */
export function PageFoot({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const foot = useMemo(() => ({ node }), [node]);
  return (
    <FootContext.Provider value={foot}>
      {children}
      <div ref={setNode} className="contents" />
    </FootContext.Provider>
  );
}

/** A page's primary action, where a phone's thumb reaches and in the flow on a desk (KEHOACH 9.21.2).
 *  `pinned` moves it to the page foot: on the window's bottom edge to the end of the page, and on a
 *  desk as tall as the rail's footer so their top borders meet (KEHOACH 9.12).
 */
export function BottomBar({ children, className, pinned = false }: { children: ReactNode; className?: string; pinned?: boolean }) {
  const foot = useContext(FootContext);
  if (pinned && foot) {
    return foot.node
      ? createPortal(
          <div
            data-bottom-bar=""
            className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 flex border-t border-kumo-line bg-kumo-base md:bottom-0 md:min-h-12 md:bg-kumo-canvas"
          >
            <div className={cn("mx-auto flex w-full max-w-(--width-shell) flex-wrap items-center gap-2 px-6 py-3 md:px-8 md:py-1 lg:px-10", className)}>
              {children}
            </div>
          </div>,
          foot.node,
        )
      : null;
  }
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
