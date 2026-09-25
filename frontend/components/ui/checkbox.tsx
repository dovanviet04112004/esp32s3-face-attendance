import type { InputHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
}

// The box stays 16 px; the label row around it carries the 44 px target.
export function Checkbox({ label, className, ...rest }: Props) {
  return (
    <label className={cn("flex min-h-11 items-center gap-2 text-sm", className)}>
      <input
        type="checkbox"
        className={cn(
          "size-4 shrink-0 rounded accent-kumo-brand",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand",
        )}
        {...rest}
      />
      {label}
    </label>
  );
}
