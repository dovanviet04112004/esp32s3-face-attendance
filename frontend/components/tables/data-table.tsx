"use client";

import { Button, DropdownMenu, Empty, LayerCard, Table } from "@cloudflare/kumo";
import type { Icon as IconType } from "@phosphor-icons/react";
import { ArrowDownIcon, ArrowUpIcon, ArrowsDownUpIcon, DotsThreeIcon, TrayIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { Failed } from "@/components/ui/failed";
import { SkeletonLine } from "@/components/ui/skeleton";
import { Link, useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/cn";
import { CardList, CardListSkeleton } from "./card-list";

export type Priority = 1 | 2 | 3;

export interface Column<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** One plain line for a phone row, when the desk cell is laid out on two lines. */
  card?: (row: T) => string;
  numeric?: boolean;
  sticky?: boolean;
  /** 1 always shows and fills the phone row; 3 hides first as the table's own box narrows (KEHOACH 9.12). */
  priority?: Priority;
  /** One line with an ellipsis; a string cell shows in full on hover. */
  truncate?: boolean;
  maxWidthPx?: number;
  /** Orders the rows already loaded, so it stays off while the list is partial. */
  sortBy?: (row: T) => string | number;
  /** The api's sort key: the header then asks the server through the table's onSortChange. */
  sortKey?: string;
}

export interface Sort {
  key: string;
  dir: "asc" | "desc";
}

type SortMode = "server" | "client" | null;

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
  /** The server's order, when the endpoint takes sort; the page keeps it in the URL. */
  sort?: Sort;
  onSortChange?: (next: Sort) => void;
  /** Which column titles a phone row; a table's leftmost column is rarely it. */
  cardLead?: string;
  /** The column held at the right end of a phone row: a state pill or an amount. */
  cardTrailing?: string;
  /** The name a phone row draws initials from; a PersonCell lead gives one by itself. */
  cardAvatar?: (row: T) => string;
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
const kTruncatePx = 280;
const HIDE_AT: Record<Priority, string> = {
  1: "",
  2: "@max-[560px]:hidden",
  3: "@max-[720px]:hidden",
};

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

function useMoreToTheRight(box: HTMLElement | null): boolean {
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (!box) {
      return;
    }
    const measure = () => setMore(box.scrollLeft + box.clientWidth < box.scrollWidth - 1);
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(box);
    if (box.firstElementChild) {
      watcher.observe(box.firstElementChild);
    }
    box.addEventListener("scroll", measure, { passive: true });
    return () => {
      watcher.disconnect();
      box.removeEventListener("scroll", measure);
    };
  }, [box]);
  return more;
}

/** How many priority levels the table drops to fit its box; each comes back once the box has the
 *  width that level overflowed at (KEHOACH 9.12).
 */
function useDropped(box: HTMLElement | null): number {
  const [dropped, setDropped] = useState(0);
  const need = useRef([0, 0]);

  // Read after every render: rows arriving widen the table without a resize.
  useLayoutEffect(() => {
    if (box && dropped < 2 && box.scrollWidth > box.clientWidth + 1) {
      need.current[dropped] = box.scrollWidth;
      setDropped(dropped + 1);
    }
  });

  useEffect(() => {
    if (!box) {
      return;
    }
    const watcher = new ResizeObserver(() => {
      const room = box.clientWidth;
      setDropped((now) => {
        let next = now;
        while (next > 0 && room >= need.current[next - 1]) {
          next -= 1;
        }
        return next;
      });
    });
    watcher.observe(box);
    return () => watcher.disconnect();
  }, [box]);

  return dropped;
}

function cellBody<T>(column: Column<T>, row: T): ReactNode {
  const content = column.cell(row);
  if (!column.truncate) {
    return content;
  }
  const full = typeof content === "string" || typeof content === "number" ? String(content) : undefined;
  return (
    <div className="truncate" style={{ maxWidth: column.maxWidthPx ?? kTruncatePx }} title={full}>
      {content}
    </div>
  );
}

function SortMark({ dir }: { dir: Sort["dir"] | null }) {
  if (dir === null) {
    return <ArrowsDownUpIcon size={14} className="text-kumo-inactive" aria-hidden />;
  }
  return dir === "desc" ? <ArrowDownIcon size={14} aria-hidden /> : <ArrowUpIcon size={14} aria-hidden />;
}

/** Name over code in one two-line cell, so a list spends one column on who (KEHOACH 9.12). */
export function PersonCell({ name, code, href }: { name: string; code?: string | null; href?: string }) {
  return (
    <div className="flex max-w-64 min-w-0 flex-col">
      {href ? (
        <Link href={href} title={name} className="truncate text-kumo-link hover:underline">
          {name}
        </Link>
      ) : (
        <span title={name} className="truncate">
          {name}
        </span>
      )}
      {code ? <span className="truncate font-mono text-sm text-kumo-subtle">{code}</span> : null}
    </div>
  );
}

/** A click on a control inside the row belongs to that control, not to the row. */
export function onControl(event: MouseEvent): boolean {
  return (event.target as HTMLElement).closest("a, button, input, select, textarea, label, [role=menuitem], [role=checkbox]") !== null;
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

/** Kumo's Table in a LayerCard on a desk, the same columns as a list of rows on a phone (KEHOACH 4.7). */
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
  sort,
  onSortChange,
  cardLead,
  cardTrailing,
  cardAvatar,
  rowHref,
  onRowClick,
  rowActions,
}: Props<T>) {
  const t = useTranslations("common");
  const router = useRouter();
  const [order, setOrder] = useState<Order>(kFresh);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const moreToTheRight = useMoreToTheRight(scroller);
  const dropped = useDropped(scroller);
  const hide = (column: Column<T>) => {
    const level = column.priority ?? 1;
    return cn(HIDE_AT[level], ((dropped >= 1 && level === 3) || (dropped >= 2 && level === 2)) && "hidden");
  };
  // Sorting 50 loaded rows of 5,000 would pass a partial order off as the whole (KEHOACH 9.12).
  const partial = paging !== undefined && (paging.shown < paging.total || paging.onMore !== undefined);
  const serverSorts = onSortChange !== undefined;

  // Reading storage during render would disagree with the server-rendered pass.
  useEffect(() => setOrder(recall(id)), [id]);

  const ordered = useMemo(() => {
    const source = rows ?? [];
    const column = columns.find((one) => one.id === order.sortId);
    if (!column?.sortBy || partial || (serverSorts && column.sortKey !== undefined)) {
      return source;
    }
    const pick = column.sortBy;
    const sorted = [...source].sort((left, right) => compare(pick(left), pick(right)));
    return order.descending ? sorted.reverse() : sorted;
  }, [rows, columns, order.sortId, order.descending, partial, serverSorts]);

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

  function modeOf(column: Column<T>): SortMode {
    if (serverSorts && column.sortKey !== undefined) {
      return "server";
    }
    return column.sortBy && !partial ? "client" : null;
  }

  function directionOf(column: Column<T>, mode: SortMode): Sort["dir"] | null {
    if (mode === "server") {
      return sort && sort.key === column.sortKey ? sort.dir : null;
    }
    if (mode === "client" && order.sortId === column.id) {
      return order.descending ? "desc" : "asc";
    }
    return null;
  }

  function sortOn(column: Column<T>, mode: SortMode): void {
    if (mode === "server" && column.sortKey !== undefined) {
      const flip = sort?.key === column.sortKey && sort.dir === "asc";
      onSortChange?.({ key: column.sortKey, dir: flip ? "desc" : "asc" });
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
  // Kumo's sticky action column already fades its own inner edge.
  const fadesEdge = rowActions === undefined;

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

      <LayerCard className="@container hidden p-0 md:block">
        <div className="relative">
          <div ref={setScroller} className="overflow-x-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  {selectable ? (
                    <Table.CheckHead
                      checked={allOn}
                      indeterminate={someOn && !allOn}
                      onCheckedChange={() => setChosen(allOn ? new Set() : new Set(ordered.map((row) => keyOf(row))))}
                      label={t("chooseAll")}
                    />
                  ) : null}
                  {columns.map((column) => {
                    const mode = modeOf(column);
                    const dir = directionOf(column, mode);
                    return (
                      <Table.Head
                        key={column.id}
                        sticky={column.sticky ? "left" : undefined}
                        aria-sort={dir === null ? undefined : dir === "desc" ? "descending" : "ascending"}
                        className={cn("whitespace-nowrap", column.numeric && "text-end", hide(column))}
                      >
                        {mode ? (
                          <button
                            type="button"
                            onClick={() => sortOn(column, mode)}
                            className={cn("inline-flex items-center gap-1 hover:text-kumo-strong", column.numeric && "flex-row-reverse")}
                          >
                            {column.header}
                            <SortMark dir={dir} />
                          </button>
                        ) : (
                          column.header
                        )}
                      </Table.Head>
                    );
                  })}
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
                          <Table.Cell key={column.id} className={hide(column)}>
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
                              label={t("chooseRow")}
                            />
                          ) : null}
                          {columns.map((column) => (
                            <Table.Cell
                              key={column.id}
                              sticky={column.sticky ? "left" : undefined}
                              className={cn(column.numeric && "text-end tabular-nums", hide(column))}
                            >
                              {cellBody(column, row)}
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
          </div>
          {fadesEdge ? (
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-y-0 end-0 w-10 bg-linear-to-l from-kumo-base to-transparent transition-opacity duration-150 motion-reduce:transition-none",
                moreToTheRight ? "opacity-100" : "opacity-0",
              )}
            />
          ) : null}
        </div>
        {paging && !pending ? <PagingRow paging={paging} /> : null}
      </LayerCard>

      <div className="md:hidden">
        {pending ? (
          <CardListSkeleton />
        ) : (
          <CardList
            columns={columns}
            rows={ordered}
            keyOf={keyOf}
            cardLead={cardLead}
            cardTrailing={cardTrailing}
            cardAvatar={cardAvatar}
            chosen={selectable ? chosen : undefined}
            onToggle={selectable ? toggleRow : undefined}
            onOpen={opens ? open : undefined}
            rowActions={rowActions}
            footer={paging ? <PagingRow paging={paging} /> : undefined}
          />
        )}
      </div>
    </div>
  );
}
