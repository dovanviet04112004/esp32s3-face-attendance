"use client";

import { ArrowDown, ArrowUp, ArrowUpDown, Columns3 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, Failed } from "@/components/ui/empty";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { CardList } from "./card-list";

export interface Column<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  numeric?: boolean;
  sticky?: boolean;
  sortBy?: (row: T) => string | number;
}

interface Props<T> {
  id: string;
  columns: Column<T>[];
  rows: T[] | undefined;
  keyOf: (row: T) => string;
  pending?: boolean;
  failed?: boolean;
  onRetry?: () => void;
  empty?: string;
  emptyHint?: string;
  emptyAction?: ReactNode;
  selectable?: boolean;
  bulk?: (chosen: T[]) => ReactNode;
  /** Reaching the rows this page did not ask for yet. */
  more?: ReactNode;
  cardLead?: string;
}

interface Memory {
  hidden: string[];
  sortId: string | null;
  descending: boolean;
}

const kStore = "table:";
const kFresh: Memory = { hidden: [], sortId: null, descending: false };

function recall(id: string): Memory {
  try {
    const raw = window.localStorage.getItem(kStore + id);
    return raw ? { ...kFresh, ...(JSON.parse(raw) as Partial<Memory>) } : kFresh;
  } catch {
    return kFresh;
  }
}

function remember(id: string, memory: Memory): void {
  try {
    window.localStorage.setItem(kStore + id, JSON.stringify(memory));
  } catch {
    return;
  }
}

function compare(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left).localeCompare(String(right));
}

export function DataTable<T>({
  id,
  columns,
  rows,
  keyOf,
  pending,
  failed,
  onRetry,
  empty,
  emptyHint,
  emptyAction,
  selectable,
  bulk,
  more,
  cardLead,
}: Props<T>) {
  const t = useTranslations("common");
  const [memory, setMemory] = useState<Memory>(kFresh);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [picking, setPicking] = useState(false);

  // Reading storage during render would disagree with the server-rendered pass.
  useEffect(() => setMemory(recall(id)), [id]);

  function keep(next: Memory): void {
    setMemory(next);
    remember(id, next);
  }

  const shown = columns.filter((column) => !memory.hidden.includes(column.id));

  const ordered = useMemo(() => {
    const source = rows ?? [];
    const column = columns.find((one) => one.id === memory.sortId);
    if (!column?.sortBy) {
      return source;
    }
    const pick = column.sortBy;
    const sorted = [...source].sort((left, right) => compare(pick(left), pick(right)));
    return memory.descending ? sorted.reverse() : sorted;
  }, [rows, columns, memory.sortId, memory.descending]);

  if (failed) {
    return <Failed onRetry={onRetry} />;
  }
  if (pending) {
    return <SkeletonRows columns={Math.min(shown.length || 4, 5)} />;
  }
  if (!ordered.length) {
    return <Empty title={empty ?? t("noData")} hint={emptyHint} action={emptyAction} />;
  }

  function sortOn(column: Column<T>): void {
    if (!column.sortBy) {
      return;
    }
    const same = memory.sortId === column.id;
    keep({ ...memory, sortId: column.id, descending: same ? !memory.descending : false });
  }

  function toggleRow(key: string): void {
    const next = new Set(chosen);
    if (!next.delete(key)) {
      next.add(key);
    }
    setChosen(next);
  }

  const allOn = ordered.length > 0 && ordered.every((row) => chosen.has(keyOf(row)));
  const picked = ordered.filter((row) => chosen.has(keyOf(row)));

  // Without the stacking order the cells sliding sideways paint over the frozen
  // one; the offset clears the selection box when the table has one.
  const frozen = cn(
    "sticky bg-(--color-surface) border-e border-(--color-line)",
    selectable ? "start-10" : "start-0",
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 pb-2">
        {selectable && picked.length > 0 ? (
          <>
            <span className="text-sm text-(--color-muted) tabular-nums">
              {t("chosen", { count: picked.length })}
            </span>
            {bulk?.(picked)}
          </>
        ) : null}
        <Button
          type="button"
          tone="quiet"
          size="sm"
          className="ms-auto"
          onClick={() => setPicking(true)}
        >
          <Columns3 className="size-4" aria-hidden />
          {t("columns")}
        </Button>
      </div>

      <div className="hidden overflow-x-auto rounded-xl border border-(--color-line) bg-(--color-surface) md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-(--color-line) text-left text-(--color-muted)">
              {selectable ? (
                <th className="sticky start-0 z-20 w-10 bg-(--color-surface) px-4 py-3">
                  <Checkbox
                    className="min-h-0"
                    aria-label={t("chooseAll")}
                    checked={allOn}
                    onChange={() =>
                      setChosen(allOn ? new Set() : new Set(ordered.map((row) => keyOf(row))))
                    }
                    label=""
                  />
                </th>
              ) : null}
              {shown.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={
                    memory.sortId === column.id
                      ? memory.descending
                        ? "descending"
                        : "ascending"
                      : undefined
                  }
                  className={cn(
                    "px-4 py-3 font-medium",
                    column.sticky && frozen,
                    column.sticky && "z-20",
                  )}
                >
                  {column.sortBy ? (
                    <button
                      type="button"
                      onClick={() => sortOn(column)}
                      className="inline-flex items-center gap-1 hover:text-(--color-ink)"
                    >
                      {column.header}
                      {memory.sortId !== column.id ? (
                        <ArrowUpDown className="size-3.5 opacity-50" aria-hidden />
                      ) : memory.descending ? (
                        <ArrowDown className="size-3.5" aria-hidden />
                      ) : (
                        <ArrowUp className="size-3.5" aria-hidden />
                      )}
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ordered.map((row) => {
              const key = keyOf(row);
              return (
                <tr key={key} className="border-b border-(--color-line) last:border-0">
                  {selectable ? (
                    <td className="sticky start-0 z-10 bg-(--color-surface) px-4 py-3">
                      <Checkbox
                        className="min-h-0"
                        aria-label={t("chooseRow")}
                        checked={chosen.has(key)}
                        onChange={() => toggleRow(key)}
                        label=""
                      />
                    </td>
                  ) : null}
                  {shown.map((column) => (
                    <td
                      key={column.id}
                      className={cn(
                        "px-4 py-3",
                        column.numeric && "tabular-nums",
                        column.sticky && frozen,
                        column.sticky && "z-10",
                      )}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <CardList
        columns={shown}
        rows={ordered}
        keyOf={keyOf}
        cardLead={cardLead}
        chosen={selectable ? chosen : undefined}
        onToggle={selectable ? toggleRow : undefined}
      />

      {more}

      <Sheet
        open={picking}
        onClose={() => setPicking(false)}
        title={t("columns")}
        closeLabel={t("close")}
      >
        <div className="flex flex-col">
          {columns.map((column) => {
            const on = !memory.hidden.includes(column.id);
            return (
              <Checkbox
                key={column.id}
                checked={on}
                disabled={on && shown.length === 1}
                onChange={() =>
                  keep({
                    ...memory,
                    hidden: on
                      ? [...memory.hidden, column.id]
                      : memory.hidden.filter((one) => one !== column.id),
                  })
                }
                label={column.header}
              />
            );
          })}
        </div>
      </Sheet>
    </div>
  );
}
