"use client";

import { XIcon } from "@phosphor-icons/react";
import { useEffect, useId, useRef, type ReactNode } from "react";

import { cn } from "@/lib/cn";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  closeLabel: string;
  children: ReactNode;
  className?: string;
}

// showModal gives escape, the focus trap and the backdrop without a library.
export function Sheet({ open, onClose, title, closeLabel, children, className }: Props) {
  const box = useRef<HTMLDialogElement>(null);
  const heading = useId();

  useEffect(() => {
    const dialog = box.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    }
    if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={box}
      aria-labelledby={heading}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === box.current) {
          onClose();
        }
      }}
      className={cn(
        "mx-auto mt-auto mb-0 max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl",
        "border border-(--color-line) bg-(--color-surface) p-4 text-(--color-ink)",
        "pb-[calc(1rem_+_env(safe-area-inset-bottom))] backdrop:bg-black/40",
        "sm:mb-auto sm:rounded-2xl sm:pb-4",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id={heading} className="text-sm font-semibold">
          {title}
        </h2>
        <button
          type="button"
          aria-label={closeLabel}
          onClick={onClose}
          className="grid size-11 place-items-center rounded-lg text-(--color-muted) hover:bg-(--color-ground)"
        >
          <XIcon className="size-5" aria-hidden />
        </button>
      </div>
      <div className="mt-3">{children}</div>
    </dialog>
  );
}
