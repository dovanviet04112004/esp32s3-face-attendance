"use client";

import { Button, DropdownMenu, Empty, LayerCard, SkeletonLine, Table } from "@cloudflare/kumo";
import type { Icon as IconType } from "@phosphor-icons/react";
import { ArrowDownIcon, ArrowUpIcon, ArrowsDownUpIcon, DotsThreeIcon, TrayIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";

import { Failed } from "@/components/ui/failed";
import { useRouter } from "@/i18n/navigation";
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

export interface RowAction {
  key: string;
  label: string;
  icon?: IconType;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface Paging {
  shown: number;
  total: number;
  exact?: boolean;
  onMore?: () => void;
  loading?: boolean;
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
  paging?: Paging;
  /** Which column titles a phone card; a table's leftmost column is rarely it. */
  cardLead?: string;
  /** Where the whole row leads; the row opens the record, not a trailing link (KEHOACH 9.15). */
  rowHref?: (row: T) => string;
  /** Or what the whole row opens in place, when the record has no page of its own. */
  onRowClick?: (row: T) => void;
  /** The row's secondary actions, in one ⋯ menu at its end (KEHOACH 9.12). */
  rowActions?: (row: T) => RowAction[];
}

interface Order {
  sortId: string | null;
  descending: boolean;
}

const kStore = "table-order:";
const kFresh: Order = { sortId: null, descending: false };
const kSkeletonRows = 6;

function recall(id: string): Order {
  try {
    const raw = window.localStorage.getItem(kStore + id);
    return raw ? { ...kFresh, ...(JSON.parse(raw) as Partial<Order>) } : kFresh;
  } catch {
    return kFresh;
  }
}

function remember(id: string, order: Order): void {
  try {
    window.localStorage.setItem(kStore + id, JSON.stringify(order));
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

/** A click on a control inside the row belongs to that control, not to the row. */
export function onControl(event: MouseEvent): boolean {
  return (event.target as HTMLElement).closest("a, button, input, select, textarea, label, [role=menuitem]") !== null;
}

export function ActionMenu({ actions, label }: { actions: RowAction[]; label: string }) {
  if (actions.length === 0) {
    return null;
  }
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={<Button variant="ghost" size="sm" shape="square" icon={<DotsThreeIcon weight="bold" size={16} />} aria-label={label} />}
      />
      <DropdownMenu.Content align="end">
        {actions.map((action, at) => (
          <DropdownMenu.Item
            key={action.key}
            icon={action.icon}
            variant={action.danger ? "danger" : "default"}
            disabled={action.disabled}
            onClick={action.onSelect}
            className={cn(action.danger && at > 0 && "mt-1")}
          >
            {action.label}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

export function PagingRow({ paging }: { paging: Paging }) {
  const t = useTranslations("common");
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-hairline px-3 py-2.5 text-kumo-subtle">
      <span className="tabular-nums">
        {t(paging.exact === false ? "showingOfAtLeast" : "showingOf", { shown: paging.shown, total: paging.total })}
      </span>
      {paging.onMore ? (
        <Button variant="secondary" size="sm" loading={paging.loading} onClick={paging.onMore}>
          {t("loadMore")}
        </Button>
      ) : null}
    </div>
  );
}

/** Kumo's Table in a LayerCard on a desk, the same columns as cards on a phone (KEHOACH 4.7). */
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
  paging,
  cardLead,
  rowHref,
  onRowClick,
  rowActions,
}: Props<T>) {
  const t = useTranslations("common");
  const router = useRouter();
  const [order, setOrder] = useState<Order>(kFresh);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());

  // Reading storage during render would disagree with the server-rendered pass.
  useEffect(() => setOrder(recall(id)), [id]);

  const ordered = useMemo(() => {
    const source = rows ?? [];
    const column = columns.find((one) => one.id === order.sortId);
    if (!column?.sortBy) {
      return source;
    }
    const pick = column.sortBy;
    const sorted = [...source].sort((left, right) => compare(pick(left), pick(right)));
    return order.descending ? sorted.reverse() : sorted;
  }, [rows, columns, order.sortId, order.descending]);

  if (failed) {
    return <Failed onRetry={onRetry} />;
  }

  const opens = rowHref !== undefined || onRowClick !== undefined;

  function open(row: T): void {
    if (rowHref) {
      router.push(rowHref(row));
      return;
    }
    onRowClick?.(row);
  }

  function sortOn(column: Column<T>): void {
    if (!column.sortBy) {
      return;
    }
    const same = order.sortId === column.id;
    const next = { sortId: column.id, descending: same ? !order.descending : false };
    setOrder(next);
    remember(id, next);
  }

  function toggleRow(key: string): void {
    const next = new Set(chosen);
    if (!next.delete(key)) {
      next.add(key);
    }
    setChosen(next);
  }

  const allOn = ordered.length > 0 && ordered.every((row) => chosen.has(keyOf(row)));
  const someOn = ordered.some((row) => chosen.has(keyOf(row)));
  const picked = ordered.filter((row) => chosen.has(keyOf(row)));

  if (!pending && ordered.length === 0) {
    return (
      <LayerCard className="p-0">
        <Empty
          icon={<TrayIcon size={40} className="text-kumo-inactive" />}
          title={empty ?? t("noData")}
          description={emptyHint}
          contents={emptyAction}
          className="py-12"
        />
      </LayerCard>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {selectable && picked.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-kumo-tint px-3 py-2">
          <span className="font-medium tabular-nums">{t("chosen", { count: picked.length })}</span>
          {bulk?.(picked)}
          <Button variant="ghost" size="sm" className="ms-auto" onClick={() => setChosen(new Set())}>
            {t("reset")}
          </Button>
        </div>
      ) : null}

      <LayerCard className="hidden overflow-x-auto p-0 md:block">
        <Table>
          <Table.Header>
            <Table.Row>
              {selectable ? (
                <Table.CheckHead
                  checked={allOn}
                  indeterminate={someOn && !allOn}
                  onCheckedChange={() => setChosen(allOn ? new Set() : new Set(ordered.map((row) => keyOf(row))))}
                  aria-label={t("chooseAll")}
                />
              ) : null}
              {columns.map((column) => (
                <Table.Head
                  key={column.id}
                  sticky={column.sticky ? "left" : undefined}
                  aria-sort={
                    order.sortId === column.id ? (order.descending ? "descending" : "ascending") : undefined
                  }
                  className={cn("whitespace-nowrap", column.numeric && "text-end")}
                >
                  {column.sortBy ? (
                    <button
                      type="button"
                      onClick={() => sortOn(column)}
                      className={cn("inline-flex items-center gap-1 hover:text-kumo-strong", column.numeric && "flex-row-reverse")}
                    >
                      {column.header}
                      {order.sortId !== column.id ? (
                        <ArrowsDownUpIcon size={14} className="text-kumo-inactive" aria-hidden />
                      ) : order.descending ? (
                        <ArrowDownIcon size={14} aria-hidden />
                      ) : (
                        <ArrowUpIcon size={14} aria-hidden />
                      )}
                    </button>
                  ) : (
                    column.header
                  )}
                </Table.Head>
              ))}
              {rowActions ? (
                <Table.Head sticky="right" className="w-12">
                  <span className="sr-only">{t("actions")}</span>
                </Table.Head>
              ) : null}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {pending
              ? Array.from({ length: kSkeletonRows }, (_, at) => (
                  <Table.Row key={`wait-${at}`}>
                    {selectable ? <Table.Cell /> : null}
                    {columns.map((column) => (
                      <Table.Cell key={column.id}>
                        <SkeletonLine minWidth={35} maxWidth={90} />
                      </Table.Cell>
                    ))}
                    {rowActions ? <Table.Cell /> : null}
                  </Table.Row>
                ))
              : ordered.map((row) => {
                  const key = keyOf(row);
                  const actions = rowActions?.(row) ?? [];
                  return (
                    <Table.Row
                      key={key}
                      variant={chosen.has(key) ? "selected" : "default"}
                      onClick={opens ? (event) => !onControl(event) && open(row) : undefined}
                      className={cn(
                        opens && "cursor-pointer hover:bg-kumo-tint hover:[--kumo-table-row-bg:var(--color-kumo-tint)]",
                      )}
                    >
                      {selectable ? (
                        <Table.CheckCell
                          checked={chosen.has(key)}
                          onCheckedChange={() => toggleRow(key)}
                          aria-label={t("chooseRow")}
                        />
                      ) : null}
                      {columns.map((column) => (
                        <Table.Cell
                          key={column.id}
                          sticky={column.sticky ? "left" : undefined}
                          className={cn(column.numeric && "text-end tabular-nums")}
                        >
                          {column.cell(row)}
                        </Table.Cell>
                      ))}
                      {rowActions ? (
                        <Table.Cell sticky="right" className="py-1.5 text-end">
                          <ActionMenu actions={actions} label={t("actions")} />
                        </Table.Cell>
                      ) : null}
                    </Table.Row>
                  );
                })}
          </Table.Body>
        </Table>
        {paging && !pending ? <PagingRow paging={paging} /> : null}
      </LayerCard>

      <div className="md:hidden">
        {pending ? (
          <LayerCard className="flex flex-col gap-3 p-4">
            {Array.from({ length: 3 }, (_, at) => (
              <SkeletonLine key={at} minWidth={25} maxWidth={43} />
            ))}
          </LayerCard>
        ) : (
          <CardList
            columns={columns}
            rows={ordered}
            keyOf={keyOf}
            cardLead={cardLead}
            chosen={selectable ? chosen : undefined}
            onToggle={selectable ? toggleRow : undefined}
            onOpen={opens ? open : undefined}
            rowActions={rowActions}
          />
        )}
        {paging && !pending ? (
          <LayerCard className="mt-2 p-0">
            <PagingRow paging={paging} />
          </LayerCard>
        ) : null}
      </div>
    </div>
  );
}
