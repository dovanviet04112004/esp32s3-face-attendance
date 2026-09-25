"use client";

import { Checkbox, LayerCard } from "@cloudflare/kumo";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { cn } from "@/lib/cn";
import { ActionMenu, onControl, type Column, type RowAction } from "./data-table";

const kFrontColumns = 3;

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  keyOf: (row: T) => string;
  chosen?: ReadonlySet<string>;
  onToggle?: (key: string) => void;
  cardLead?: string;
  onOpen?: (row: T) => void;
  rowActions?: (row: T) => RowAction[];
}

/** The same columns a table draws as rows, drawn as cards (KEHOACH 9.21.1). */
export function CardList<T>({ columns, rows, keyOf, chosen, onToggle, cardLead, onOpen, rowActions }: Props<T>) {
  const t = useTranslations("common");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const at = Math.max(0, columns.findIndex((column) => column.id === cardLead));
  const lead = columns[at];
  const rest = columns.filter((_, index) => index !== at);
  const front = rest.slice(0, kFrontColumns - 1);
  const back = rest.slice(kFrontColumns - 1);

  function flip(key: string): void {
    const next = new Set(open);
    if (!next.delete(key)) {
      next.add(key);
    }
    setOpen(next);
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => {
        const key = keyOf(row);
        const shown = open.has(key);
        const actions = rowActions?.(row) ?? [];
        return (
          <LayerCard
            key={key}
            render={<li />}
            onClick={onOpen ? (event) => !onControl(event) && onOpen(row) : undefined}
            className={cn("p-4", onOpen && "cursor-pointer active:bg-kumo-tint")}
          >
            <div className="flex items-start gap-2">
              {chosen && onToggle ? (
                <Checkbox checked={chosen.has(key)} onCheckedChange={() => onToggle(key)} aria-label={t("chooseRow")} />
              ) : null}
              <div className="min-w-0 flex-1 font-medium">{lead?.cell(row)}</div>
              <ActionMenu actions={actions} label={t("actions")} />
              {onOpen && actions.length === 0 ? (
                <CaretRightIcon size={16} className="mt-0.5 shrink-0 text-kumo-subtle" aria-hidden />
              ) : null}
            </div>

            <dl className="mt-2 flex flex-col gap-1">
              {(shown ? [...front, ...back] : front).map((column) => (
                <div key={column.id} className="flex justify-between gap-3">
                  <dt className="text-kumo-subtle">{column.header}</dt>
                  <dd className={cn("min-w-0 text-end", column.numeric && "tabular-nums")}>{column.cell(row)}</dd>
                </div>
              ))}
            </dl>

            {back.length > 0 ? (
              <button
                type="button"
                aria-expanded={shown}
                onClick={() => flip(key)}
                className="mt-1 flex min-h-11 w-full items-center justify-center gap-1 text-kumo-subtle"
              >
                {shown ? t("less") : t("more")}
                <CaretDownIcon size={16} className={cn("transition-transform", shown && "rotate-180")} aria-hidden />
              </button>
            ) : null}
          </LayerCard>
        );
      })}
    </ul>
  );
}
