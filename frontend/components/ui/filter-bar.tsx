"use client";

import { Badge, Button, Combobox, InputGroup, LayerDialog, Select, Toolbar } from "@cloudflare/kumo";
import { FunnelSimpleIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useFormatter, useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { DateField } from "@/components/ui/date-field";
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
  /** A date range: beside the toolbar on a desk, inside the filter sheet on a phone. */
  range?: { from: string; to: string; onFrom: (next: string) => void; onTo: (next: string) => void };
}

interface Choice {
  value: string;
  label: string;
}

const kToolbarTrigger = "max-w-60 justify-between";

type Fit = "row" | "split" | "sheet";

/** The widest desk layout whose toolbar still fits the bar's own box (KEHOACH 9.12).
 *  A layout that overflowed keeps the width it needed, so a wider box brings it back.
 */
function useFit(splits: boolean) {
  const box = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const need = useRef<Record<Fit, number>>({ row: 0, split: 0, sheet: 0 });
  const [fit, setFit] = useState<Fit>("row");

  // Read after every render: a longer value on a trigger widens the toolbar without a resize.
  useLayoutEffect(() => {
    const room = box.current?.clientWidth ?? 0;
    const width = bar.current?.offsetWidth ?? 0;
    if (fit !== "sheet" && room > 0 && width > room + 1) {
      need.current[fit] = width;
      setFit(fit === "row" && splits ? "split" : "sheet");
    }
  });

  useEffect(() => {
    const held = box.current;
    if (!held) {
      return;
    }
    const watch = new ResizeObserver(() => {
      const room = held.clientWidth;
      setFit((now) => {
        if (now !== "row" && room >= need.current.row) {
          return "row";
        }
        return now === "sheet" && splits && room >= need.current.split ? "split" : now;
      });
    });
    watch.observe(held);
    return () => watch.disconnect();
  }, [splits]);

  return { box, bar, fit };
}

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
        render={
          inSheet ? undefined : (
            <Toolbar.Button
              aria-label={filter.label}
              className={cn(kToolbarTrigger, "truncate font-normal!", filter.value === "" && "text-kumo-placeholder!")}
            />
          )
        }
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

/** Kumo's Toolbar above a table: on a desk the widest layout that fits its box, on a phone the
 *  search with the rest in a sheet (KEHOACH 9.12, 9.21.1). Filters apply as they change.
 */
export function FilterBar({ search, filters = [], extra, range }: Props) {
  const common = useTranslations("common");
  const wide = useWide();
  const { box, bar, fit } = useFit(search !== undefined && filters.length > 0);
  const [open, setOpen] = useState(false);
  const active = filters.filter((one) => one.value !== "").length + (range && (range.from || range.to) ? 1 : 0);

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

  const searchTool = search ? (
    <Toolbar.InputGroup aria-label={search.placeholder} className="min-w-56 flex-1">
      {searchBox}
    </Toolbar.InputGroup>
  ) : null;
  const filterTools = filters.map((one) => <FilterControl key={one.key} filter={one} inSheet={false} />);
  const extraTools = extra ? <div className="ms-auto flex flex-wrap items-center gap-2">{extra}</div> : null;
  const rangeTools = range ? (
    <div className="flex items-center gap-2">
      <div className="w-40">
        <DateField label={common("from")} hideLabel required={false} value={range.from} max={range.to || undefined} onChange={range.onFrom} />
      </div>
      <span className="text-kumo-subtle">–</span>
      <div className="w-40">
        <DateField label={common("to")} hideLabel required={false} value={range.to} min={range.from || undefined} onChange={range.onTo} />
      </div>
    </div>
  ) : null;
  const filterLabel = active > 0 ? `${common("filters")} · ${active}` : common("filters");

  return (
    <div ref={box} className="mb-4">
      {wide && fit === "row" ? (
        <div className="flex flex-wrap items-center gap-2">
          {search || filters.length > 0 ? (
            <Toolbar ref={bar} className="flex-1">
              {searchTool}
              {filterTools}
            </Toolbar>
          ) : null}
          {rangeTools}
          {extraTools}
        </div>
      ) : wide && fit === "split" ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Toolbar className="flex-1">{searchTool}</Toolbar>
            {extraTools}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Toolbar ref={bar} className="w-max">
              {filterTools}
            </Toolbar>
            {rangeTools}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {search ? <InputGroup className="min-w-0 flex-1 basis-48">{searchBox}</InputGroup> : null}
          {filters.length > 0 || range ? (
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
          {extra ? (
            <div className={cn("flex flex-wrap items-center gap-2", wide ? "ms-auto" : search && "basis-full")}>{extra}</div>
          ) : null}
        </div>
      )}

      <LayerDialog.Root open={open} onOpenChange={setOpen}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{common("filters")}</LayerDialog.Title>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              {filters.map((one) => (
                <FilterControl key={one.key} filter={one} inSheet />
              ))}
              {range ? (
                <div className="grid grid-cols-2 gap-3">
                  <DateField label={common("from")} required={false} value={range.from} max={range.to || undefined} onChange={range.onFrom} />
                  <DateField label={common("to")} required={false} value={range.to} min={range.from || undefined} onChange={range.onTo} />
                </div>
              ) : null}
            </div>
          </LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </div>
  );
}
