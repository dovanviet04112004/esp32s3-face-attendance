"use client";

import { Combobox, Loader } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { useSettled } from "@/components/ui/filter-bar";
import { api } from "@/lib/api";

export interface Person {
  id: number;
  code: string;
  fullName: string;
}

const kPickTake = 20;
// The input also refills itself with the chosen label; only keystrokes are a search.
const TYPED: ReadonlySet<string> = new Set(["input-change", "input-clear", "clear-press"]);

/** One field that finds an active person by code or name, the same everywhere (KEHOACH 9.12).
 *  @param value the person held; the list asks /employees as the user types.
 */
export function PersonPicker({
  label,
  description,
  error,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  error?: string;
  value: Person | null;
  onChange: (next: Person | null) => void;
}) {
  const t = useTranslations("employees");
  const common = useTranslations("common");
  const [typed, setTyped] = useState("");
  const asked = useSettled(typed.trim());

  const found = useQuery({
    queryKey: ["employees", "pick", asked],
    enabled: asked !== "",
    queryFn: async () =>
      (await api.get<{ rows: Person[] }>(`/employees?search=${encodeURIComponent(asked)}&active=true&take=${kPickTake}`)).data
        .rows,
  });

  const items = asked !== "" ? (found.data ?? []) : value ? [value] : [];

  return (
    <Combobox
      items={items}
      value={value}
      onValueChange={(next) => onChange((next as Person | null) ?? null)}
      onInputValueChange={(next, details) => {
        if (TYPED.has(details.reason)) {
          setTyped(next);
        }
      }}
      filter={null}
      itemToStringLabel={(one: Person) => `${one.fullName} · ${one.code}`}
      isItemEqualToValue={(one: Person, held: Person) => one.id === held.id}
      label={label}
      description={description}
      error={error}
    >
      <Combobox.TriggerInput placeholder={t("searchHint")} clearLabel={common("clear")} showOptionsLabel={common("showOptions")} />
      <Combobox.Content>
        <Combobox.Empty>
          {found.isFetching ? (
            <span className="flex items-center gap-2 text-kumo-subtle">
              <Loader size={14} />
              {t("pickSearching")}
            </span>
          ) : asked !== "" ? (
            t("noMatch")
          ) : (
            t("pickTypeToSearch")
          )}
        </Combobox.Empty>
        <Combobox.List>
          {(one: Person) => (
            <Combobox.Item key={one.id} value={one}>
              <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                <span className="truncate">{one.fullName}</span>
                <span className="shrink-0 font-mono text-kumo-subtle">{one.code}</span>
              </span>
            </Combobox.Item>
          )}
        </Combobox.List>
      </Combobox.Content>
    </Combobox>
  );
}
