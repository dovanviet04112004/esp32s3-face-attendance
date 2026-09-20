import { cn } from "@/lib/cn";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "animate-pulse rounded bg-(--color-line) motion-reduce:animate-none",
        className,
      )}
    />
  );
}

/** Rows the height of real ones, so the page does not jump when data lands. */
export function SkeletonRows({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="divide-y divide-(--color-line) rounded-xl border border-(--color-line) bg-(--color-surface)">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex items-center gap-4 px-4 py-3.5">
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton key={column} className={column === 0 ? "h-4 w-40" : "h-4 flex-1"} />
          ))}
        </div>
      ))}
    </div>
  );
}
