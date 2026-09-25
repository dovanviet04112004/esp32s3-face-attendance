"use client";

import { Checkbox, LayerCard, SkeletonLine } from "@cloudflare/kumo";
import { CaretRightIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { isValidElement, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { ActionMenu, onControl, PersonCell, type Column, type RowAction } from "./data-table";

const kSkeletonRows = 5;
const kRow = "flex min-h-14 items-center gap-3 px-4 py-2.5";

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  keyOf: (row: T) => string;
  chosen?: ReadonlySet<string>;
  onToggle?: (key: string) => void;
  cardLead?: string;
  cardTrailing?: string;
  cardAvatar?: (row: T) => string;
  onOpen?: (row: T) => void;
  rowActions?: (row: T) => RowAction[];
  /** Under the last row, inside the same card: the paging row. */
  footer?: ReactNode;
}

interface Who {
  name: string;
  code?: string | null;
}

function personIn(node: ReactNode): Who | null {
  return isValidElement<Who>(node) && node.type === PersonCell ? node.props : null;
}

function inline(node: ReactNode): ReactNode {
  const person = personIn(node);
  return person ? [person.name, person.code].filter(Boolean).join(" · ") : node;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words.at(0)?.charAt(0) ?? "";
  const last = words.length > 1 ? (words.at(-1)?.charAt(0) ?? "") : "";
  return (first + last).toLocaleUpperCase();
}

function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="grid size-9 shrink-0 place-items-center rounded-full bg-kumo-tint text-sm font-medium text-kumo-subtle"
    >
      {initials(name)}
    </span>
  );
}

function shows(node: ReactNode, blank: string): boolean {
  return node !== null && node !== undefined && node !== false && node !== "" && node !== blank;
}

/** The same rows, drawn while the list loads. */
export function CardListSkeleton() {
  return (
    <LayerCard className="p-0">
      <ul className="divide-y divide-kumo-hairline">
        {Array.from({ length: kSkeletonRows }, (_, at) => (
          <li key={at} className={cn(kRow, "flex-col items-stretch justify-center gap-1.5")}>
            <SkeletonLine minWidth={35} maxWidth={60} />
            <SkeletonLine minWidth={20} maxWidth={45} />
          </li>
        ))}
      </ul>
    </LayerCard>
  );
}

/** The table's rows as one card of divided rows, the way a phone's own contacts read (KEHOACH 9.21.1).
 *  Title is the lead column; the line under it joins the other priority-1 columns.
 */
export function CardList<T>({
  columns,
  rows,
  keyOf,
  chosen,
  onToggle,
  cardLead,
  cardTrailing,
  cardAvatar,
  onOpen,
  rowActions,
  footer,
}: Props<T>) {
  const t = useTranslations("common");
  const lead = columns.find((column) => column.id === cardLead) ?? columns[0];
  const trailing = columns.find((column) => column.id === cardTrailing);
  const rest = columns.filter((column) => column !== lead && column !== trailing);
  // A row with no record behind it carries every value, since nothing opens to show the rest.
  const under = onOpen
    ? rest.filter((column) => (column.priority ?? 1) === 1)
    : [...rest].sort((left, right) => (left.priority ?? 1) - (right.priority ?? 1));

  return (
    <LayerCard className="p-0">
      <ul className="divide-y divide-kumo-hairline">
        {rows.map((row) => {
          const key = keyOf(row);
          const actions = rowActions?.(row) ?? [];
          const top = lead?.cell(row);
          const person = personIn(top);
          const avatar = cardAvatar?.(row) ?? person?.name;
          const parts = [person?.code, ...under.map((column) => inline(column.cell(row)))].filter((part) =>
            shows(part, t("empty")),
          );
          return (
            <li
              key={key}
              onClick={onOpen ? (event) => !onControl(event) && onOpen(row) : undefined}
              className={cn(kRow, onOpen && "cursor-pointer active:bg-kumo-tint")}
            >
              {chosen && onToggle ? (
                <Checkbox checked={chosen.has(key)} onCheckedChange={() => onToggle(key)} aria-label={t("chooseRow")} />
              ) : null}
              {avatar ? <Avatar name={avatar} /> : null}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{person ? person.name : top}</div>
                {parts.length > 0 ? (
                  <div className={cn("text-sm text-kumo-subtle", onOpen ? "truncate" : "line-clamp-2")}>
                    {parts.map((part, at) => (
                      <span key={at}>
                        {at > 0 ? " · " : null}
                        {part}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              {trailing ? (
                <div className={cn("shrink-0 text-end", trailing.numeric && "tabular-nums")}>{trailing.cell(row)}</div>
              ) : null}
              <ActionMenu actions={actions} label={t("actions")} />
              {onOpen && actions.length === 0 ? (
                <CaretRightIcon size={16} className="shrink-0 text-kumo-subtle" aria-hidden />
              ) : null}
            </li>
          );
        })}
      </ul>
      {footer}
    </LayerCard>
  );
}
