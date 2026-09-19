import type { InputHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-lg border border-(--color-line) bg-(--color-surface) px-3 text-sm",
        "placeholder:text-(--color-muted) focus-visible:outline-2 focus-visible:outline-offset-2",
        "focus-visible:outline-(--color-accent)",
        className,
      )}
      {...rest}
    />
  );
}
