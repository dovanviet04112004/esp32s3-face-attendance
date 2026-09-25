import { Badge } from "@cloudflare/kumo";
import type { ReactNode } from "react";

export type Tone = "waiting" | "good" | "bad" | "idle";

const VARIANT = { waiting: "warning", good: "success", bad: "error", idle: "secondary" } as const;

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
    <Badge variant={VARIANT[tone]} className={className}>
      {children}
    </Badge>
  );
}

/** A count beside a heading, which is a quantity and not a state. */
export function CountPill({ children }: { children: ReactNode }) {
  return (
    <Badge variant="secondary" className="tabular-nums">
      {children}
    </Badge>
  );
}
