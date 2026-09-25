"use client";

import { Button, InputGroup, LayerDialog, Select, Toolbar } from "@cloudflare/kumo";
import { FunnelSimpleIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

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
}

interface Props {
  search?: { value: string; onChange: (value: string) => void; placeholder: string };
  filters?: Filter[];
  /** Actions on the list as a whole, at the right end of the row. */
  extra?: ReactNode;
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
              <Select
                key={one.key}
                aria-label={one.label}
                value={one.value}
                onValueChange={(next) => one.onChange(String(next ?? ""))}
                items={one.items}
                render={<Toolbar.Button className="min-w-40 justify-between" />}
              />
            ))}
          </Toolbar>
        ) : null}
        {extra ? <div className="ms-auto flex flex-wrap items-center gap-2">{extra}</div> : null}
      </div>
    );
  }

  return (
    <div className="mb-4 flex flex-col gap-2">
      {search ? <InputGroup className="w-full">{searchBox}</InputGroup> : null}
      {filters.length > 0 || extra ? (
        <div className="flex flex-wrap items-center gap-2">
          {filters.length > 0 ? (
            <Button variant="secondary" icon={FunnelSimpleIcon} onClick={() => setOpen(true)}>
              {active > 0 ? `${common("filters")} · ${active}` : common("filters")}
            </Button>
          ) : null}
          {extra}
        </div>
      ) : null}

      <LayerDialog.Root open={open} onOpenChange={setOpen}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{common("filters")}</LayerDialog.Title>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              {filters.map((one) => (
                <Select
                  key={one.key}
                  label={one.label}
                  hideLabel={false}
                  value={one.value}
                  onValueChange={(next) => one.onChange(String(next ?? ""))}
                  items={one.items}
                  className="w-full"
                />
              ))}
            </div>
          </LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </div>
  );
}
