"use client";

import { SlidersHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";

import { BottomBar } from "@/components/ui/bottom-bar";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";

const WIDE = "(min-width: 48rem)";

/** Rendered once, so the controls inside keep their ids unique. */
function useWide(): boolean {
  const listen = useCallback((again: () => void) => {
    const query = window.matchMedia(WIDE);
    query.addEventListener("change", again);
    return () => query.removeEventListener("change", again);
  }, []);
  return useSyncExternalStore(
    listen,
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

interface Props {
  children: ReactNode;
  /** Left out when the controls drive the query as they change. */
  onApply?: (event: FormEvent) => void;
  extra?: ReactNode;
}

/** Filters, a row on a desk and one button on a phone, where the same row is a
 *  crush of half-width controls (KEHOACH 9.21.2). */
export function FilterBar({ children, onApply, extra }: Props) {
  const common = useTranslations("common");
  const wide = useWide();
  const [open, setOpen] = useState(false);

  if (wide) {
    return (
      <form className="mb-4 flex flex-wrap items-end gap-2" onSubmit={onApply}>
        {children}
        {onApply ? <Button type="submit">{common("apply")}</Button> : null}
        {extra}
      </form>
    );
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button type="button" tone="quiet" onClick={() => setOpen(true)}>
          <SlidersHorizontal className="size-4" aria-hidden />
          {common("filters")}
        </Button>
        {extra}
      </div>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={common("filters")}
        closeLabel={common("close")}
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onApply?.(event);
            setOpen(false);
          }}
        >
          {children}
          <BottomBar>
            <Button type="submit" className="w-full">
              {onApply ? common("apply") : common("close")}
            </Button>
          </BottomBar>
        </form>
      </Sheet>
    </>
  );
}
