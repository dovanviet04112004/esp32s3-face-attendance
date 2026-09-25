"use client";

import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useState, type MouseEvent } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/cn";
import type { Column } from "./data-table";

const kFrontColumns = 3;

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  keyOf: (row: T) => string;
  chosen?: ReadonlySet<string>;
  onToggle?: (key: string) => void;
  /** Which column titles the card; a table's leftmost column is rarely it. */
  cardLead?: string;
  /** A column of buttons, which a card shows without asking to be opened. */
  cardActions?: string;
  /** Where tapping the card leads, as the whole row does on a desk (KEHOACH 9.21.1). */
  cardHref?: (row: T) => string;
}

/** The same columns a table draws as rows, drawn as cards (KEHOACH 9.21.1). */
export function CardList<T>({
  columns,
  rows,
  keyOf,
  chosen,
  onToggle,
  cardLead,
  cardActions,
  cardHref,
}: Props<T>) {
  const t = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const at = Math.max(0, columns.findIndex((column) => column.id === cardLead));
  const lead = columns[at];
  const doing = columns.findIndex((column) => column.id === cardActions);
  const acts = doing < 0 ? undefined : columns[doing];
  const rest = columns.filter((_, index) => index !== at && index !== doing);
  const front = rest.slice(0, kFrontColumns - 1);
  const back = rest.slice(kFrontColumns - 1);

  function flip(key: string): void {
    const next = new Set(open);
    if (!next.delete(key)) {
      next.add(key);
    }
    setOpen(next);
  }

  function go(event: MouseEvent<HTMLLIElement>, row: T): void {
    if (!cardHref || (event.target as HTMLElement).closest("a, button, input, select, textarea, label")) {
      return;
    }
    router.push(cardHref(row));
  }

  return (
    <ul className="flex flex-col gap-2 md:hidden">
      {rows.map((row) => {
        const key = keyOf(row);
        const shown = open.has(key);
        return (
          <li
            key={key}
            onClick={cardHref ? (event) => go(event, row) : undefined}
            className={cn("rounded-lg bg-kumo-base p-4 ring-1 ring-kumo-line", cardHref && "cursor-pointer active:bg-kumo-tint")}
          >
            <div className="flex items-start gap-2">
              {chosen && onToggle ? (
                <Checkbox
                  className="min-h-0"
                  aria-label={t("chooseRow")}
                  checked={chosen.has(key)}
                  onChange={() => onToggle(key)}
                  label=""
                />
              ) : null}
              <div className="min-w-0 flex-1 font-medium">{lead?.cell(row)}</div>
              {cardHref ? <CaretRightIcon className="size-4 shrink-0 text-kumo-subtle" aria-hidden /> : null}
            </div>

            <dl className="mt-2 flex flex-col gap-1 text-sm">
              {(shown ? [...front, ...back] : front).map((column) => (
                <div key={column.id} className="flex justify-between gap-3">
                  <dt className="text-kumo-subtle">{column.header}</dt>
                  <dd className={cn("text-end", column.numeric && "tabular-nums")}>
                    {column.cell(row)}
                  </dd>
                </div>
              ))}
            </dl>

            {acts ? <div className="mt-2 flex flex-wrap gap-2">{acts.cell(row)}</div> : null}

            {back.length > 0 ? (
              <button
                type="button"
                aria-expanded={shown}
                onClick={() => flip(key)}
                className="mt-1 flex min-h-11 w-full items-center justify-center gap-1 text-sm text-kumo-subtle"
              >
                {shown ? t("less") : t("more")}
                <CaretDownIcon className={cn("size-4 transition-transform", shown && "rotate-180")} aria-hidden />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
