import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

// A coarse pointer is a finger, and its floor is 44 px (KEHOACH 9.21.2).
const styles = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-accent)",
  {
    variants: {
      tone: {
        solid: "bg-(--color-accent) text-white hover:opacity-90",
        quiet: "border border-(--color-line) bg-(--color-surface) hover:bg-(--color-ground)",
        danger: "bg-(--color-danger) text-white hover:opacity-90",
      },
      size: {
        md: "h-10 px-4 pointer-coarse:h-11",
        sm: "h-8 px-3 text-xs pointer-coarse:h-11 pointer-coarse:px-4 pointer-coarse:text-sm",
        touch: "h-11 px-4",
        icon: "size-10 pointer-coarse:size-11",
      },
    },
    defaultVariants: { tone: "solid", size: "md" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof styles>;

export function Button({ className, tone, size, ...rest }: ButtonProps) {
  return <button className={cn(styles({ tone, size }), className)} {...rest} />;
}
