import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export type Tone = "waiting" | "good" | "bad" | "idle";

const TONE: Record<Tone, string> = {
  waiting: "border-(--color-warn) text-(--color-warn)",
  good: "border-(--color-ok) text-(--color-ok)",
  bad: "border-(--color-danger) text-(--color-danger)",
  idle: "border-(--color-line) text-(--color-muted)",
};

/** A state reads as a word first and a tone second (KEHOACH 9.12 rule 2). */
export function StatePill({
  tone = "idle",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={cn("rounded-full border px-2 py-0.5 text-xs", TONE[tone], className)}>
      {children}
    </span>
  );
}

/** A count beside a heading, which is a quantity and not a state. */
export function CountPill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-(--color-ground) px-2 py-0.5 text-xs text-(--color-muted) tabular-nums">
      {children}
    </span>
  );
}
