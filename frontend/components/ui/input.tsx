import type { ComponentPropsWithRef } from "react";

import { cn } from "@/lib/cn";

export function Input({ className, ...rest }: ComponentPropsWithRef<"input">) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-lg border border-(--color-line) bg-(--color-surface) px-3 text-sm",
        "pointer-coarse:h-11 placeholder:text-(--color-muted)",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-accent)",
        className,
      )}
      {...rest}
    />
  );
}
