"use client";

import { Combobox } from "@cloudflare/kumo";
import { useTranslations } from "next-intl";
import { useMemo, type ReactNode } from "react";

import { fold } from "@/lib/format";

interface Entry {
  id: string;
  code: string;
  name: string;
}

/** One entry of a catalogue, picked from a list that folds marks as global search does (KEHOACH 4.7).
 *  With `none`, an entry standing for none of them leads the list and every entry reads "CODE · Name";
 *  without it, each entry shows its name with the code aside.
 */
export function ChoiceField({
  label,
  description,
  items,
  value,
  onChange,
  none,
  placeholder,
  empty,
}: {
  label: ReactNode;
  description?: string;
  items: Entry[];
  value: string;
  onChange: (next: string) => void;
  none?: string;
  /** What the empty field says; the search hint by default. */
  placeholder?: string;
  /** What the open list says when the catalogue itself has nothing yet. */
  empty?: string;
}) {
  const common = useTranslations("common");
  const noneEntry = useMemo((): Entry | null => (none === undefined ? null : { id: "", code: "", name: none }), [none]);
  const listed = useMemo(() => (noneEntry ? [noneEntry, ...items] : items), [noneEntry, items]);
  const held = items.find((one) => one.id === value) ?? noneEntry;
  const textOf = (one: Entry) => (noneEntry === null || one === noneEntry ? one.name : `${one.code} · ${one.name}`);
  return (
    <Combobox
      items={listed}
      value={held}
      onValueChange={(next) => onChange((next as Entry | null)?.id ?? "")}
      itemToStringLabel={textOf}
      isItemEqualToValue={(one: Entry, other: Entry) => one.id === other.id}
      filter={(one: Entry, typed: string) => fold(noneEntry ? textOf(one) : `${one.code} ${one.name}`).includes(fold(typed.trim()))}
      label={label}
      description={description}
    >
      <Combobox.TriggerInput placeholder={placeholder ?? common("search")} clearLabel={common("clear")} showOptionsLabel={common("showOptions")} />
      <Combobox.Content>
        <Combobox.Empty>{items.length === 0 && empty !== undefined ? empty : common("noMatch")}</Combobox.Empty>
        <Combobox.List>
          {(one: Entry) => (
            <Combobox.Item key={one.id} value={one}>
              {noneEntry ? (
                textOf(one)
              ) : (
                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="truncate">{one.name}</span>
                  <span className="shrink-0 font-mono text-kumo-subtle">{one.code}</span>
                </span>
              )}
            </Combobox.Item>
          )}
        </Combobox.List>
      </Combobox.Content>
    </Combobox>
  );
}
