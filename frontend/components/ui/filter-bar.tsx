"use client";

import { Badge, Button, Combobox, InputGroup, LayerDialog, Select, Toolbar } from "@cloudflare/kumo";
import { FunnelSimpleIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

import { cn } from "@/lib/cn";

const WIDE = "(min-width: 48rem)";
const kSettleMs = 300;

/** The value once typing pauses: a keystroke is not a query. */
export function useSettled<T>(value: T, delayMs = kSettleMs): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

/** Rendered once, so the controls inside keep their ids unique. */
function useWide(): boolean {
  const listen = useCallback((again: () => void) => {
    const query = window.matchMedia(WIDE);
    query.addEventListener("change", again);
    return () => query.removeEventListener("change", again);
  }, []);
  return useSyncExternalStore(
    listen,
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

export interface Filter {
  key: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Value to label; the "" entry is the unfiltered choice. */
  items: Record<string, string>;
  /** Rows per value, shown inside its option, never as a second list beside the table (KEHOACH 9.12). */
  counts?: Record<string, number | undefined>;
  /** A long list, such as departments: the options open with a search box. */
  searchable?: boolean;
}

interface Props {
  search?: { value: string; onChange: (value: string) => void; placeholder: string };
  filters?: Filter[];
  /** Actions on the list as a whole, at the right end of the row. */
  extra?: ReactNode;
}

interface Choice {
  value: string;
  label: string;
}

const kToolbarTrigger = "min-w-40 justify-between";

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

function Counted({ label, count }: { label: string; count: number | undefined }) {
  const format = useFormatter();
  return (
    <span className="flex w-full min-w-0 flex-1 items-center justify-between gap-6">
      <span className="truncate">{label}</span>
      {count === undefined ? null : <span className="shrink-0 text-kumo-subtle tabular-nums">{format.number(count)}</span>}
    </span>
  );
}

function SearchableFilter({ filter, inSheet }: { filter: Filter; inSheet: boolean }) {
  const common = useTranslations("common");
  const choices = useMemo(
    () => Object.entries(filter.items).map(([value, label]): Choice => ({ value, label })),
    [filter.items],
  );
  const held = choices.find((one) => one.value === filter.value) ?? null;
  return (
    <Combobox
      items={choices}
      value={held}
      onValueChange={(next) => filter.onChange((next as Choice | null)?.value ?? "")}
      itemToStringLabel={(one: Choice) => one.label}
      isItemEqualToValue={(one: Choice, other: Choice) => one.value === other.value}
      filter={(one: Choice, typed: string) => fold(one.label).includes(fold(typed.trim()))}
      label={inSheet ? filter.label : undefined}
    >
      <Combobox.TriggerValue
        className={inSheet ? "w-full" : undefined}
        render={inSheet ? undefined : <Toolbar.Button aria-label={filter.label} className={kToolbarTrigger} />}
      />
      <Combobox.Content>
        <Combobox.Input placeholder={common("search")} aria-label={filter.label} />
        <Combobox.Empty>{common("noMatch")}</Combobox.Empty>
        <Combobox.List>
          {(one: Choice) => (
            <Combobox.Item key={one.value} value={one}>
              <Counted label={one.label} count={filter.counts?.[one.value]} />
            </Combobox.Item>
          )}
        </Combobox.List>
      </Combobox.Content>
    </Combobox>
  );
}

function FilterControl({ filter, inSheet }: { filter: Filter; inSheet: boolean }) {
  if (filter.searchable) {
    return <SearchableFilter filter={filter} inSheet={inSheet} />;
  }
  const placement = inSheet
    ? { label: filter.label, className: "w-full" }
    : { "aria-label": filter.label, render: <Toolbar.Button className={kToolbarTrigger} /> };
  return (
    <Select {...placement} value={filter.value} onValueChange={(next) => filter.onChange(String(next ?? ""))} items={filter.items}>
      {filter.counts
        ? Object.entries(filter.items).map(([value, label]) => (
            <Select.Option key={value} value={value} className="[&>:first-child]:flex-1">
              <Counted label={label} count={filter.counts?.[value]} />
            </Select.Option>
          ))
        : undefined}
    </Select>
  );
}

/** Kumo's Toolbar above a table on a desk; on a phone the search stays and the
 *  rest moves into a sheet (KEHOACH 9.21.1). Filters apply as they change.
 */
export function FilterBar({ search, filters = [], extra }: Props) {
  const common = useTranslations("common");
  const wide = useWide();
  const [open, setOpen] = useState(false);
  const active = filters.filter((one) => one.value !== "").length;

  const searchBox = search ? (
    <>
      <InputGroup.Addon>
        <MagnifyingGlassIcon />
      </InputGroup.Addon>
      <InputGroup.Input
        type="search"
        value={search.value}
        placeholder={search.placeholder}
        aria-label={search.placeholder}
        onChange={(event) => search.onChange(event.target.value)}
      />
    </>
  ) : null;

  if (wide) {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {search || filters.length > 0 ? (
          <Toolbar className="min-w-0 flex-1">
            {search ? (
              <Toolbar.InputGroup aria-label={search.placeholder} className="min-w-56 flex-1">
                {searchBox}
              </Toolbar.InputGroup>
            ) : null}
            {filters.map((one) => (
              <FilterControl key={one.key} filter={one} inSheet={false} />
            ))}
          </Toolbar>
        ) : null}
        {extra ? <div className="ms-auto flex flex-wrap items-center gap-2">{extra}</div> : null}
      </div>
    );
  }

  const filterLabel = active > 0 ? `${common("filters")} · ${active}` : common("filters");

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {search ? <InputGroup className="min-w-0 flex-1 basis-48">{searchBox}</InputGroup> : null}
      {filters.length > 0 ? (
        <span className="relative shrink-0">
          <Button
            variant="secondary"
            shape="square"
            icon={FunnelSimpleIcon}
            aria-label={filterLabel}
            title={filterLabel}
            className="pointer-coarse:size-11"
            onClick={() => setOpen(true)}
          />
          {active > 0 ? (
            <Badge variant="primary" className="pointer-events-none absolute -end-1.5 -top-1.5 px-1.5 tabular-nums">
              {active}
            </Badge>
          ) : null}
        </span>
      ) : null}
      {extra ? <div className={cn("flex flex-wrap items-center gap-2", search && "basis-full")}>{extra}</div> : null}

      <LayerDialog.Root open={open} onOpenChange={setOpen}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{common("filters")}</LayerDialog.Title>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              {filters.map((one) => (
                <FilterControl key={one.key} filter={one} inSheet />
              ))}
            </div>
          </LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </div>
  );
}
