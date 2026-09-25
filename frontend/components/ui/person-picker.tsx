"use client";

import { Combobox, Loader } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { useSettled } from "@/components/ui/filter-bar";
import { api } from "@/lib/api";

export interface Person {
  id: number;
  code: string;
  fullName: string;
  department?: { name: string } | null;
}

interface Band {
  value: string;
  items: Person[];
}

interface Opening {
  near: Person[];
  rest: Person[];
  total: number;
}

const kPickTake = 20;
// The input also refills itself with the chosen label; only keystrokes are a search.
const TYPED: ReadonlySet<string> = new Set(["input-change", "input-clear", "clear-press"]);

async function activePage(query: string): Promise<{ rows: Person[]; total: number }> {
  return (await api.get<{ rows: Person[]; total: number }>(`/employees?active=true&take=${kPickTake}${query}`)).data;
}

function isBand(entry: Person | Band): entry is Band {
  return "items" in entry;
}

/** One field that finds an active person by code or name, the same everywhere (KEHOACH 9.12).
 *  @param near a department whose people lead the opening list, ahead of everyone else
 */
export function PersonPicker({
  label,
  description,
  error,
  value,
  near,
  onChange,
}: {
  label: ReactNode;
  description?: string;
  error?: string;
  value: Person | null;
  near?: string;
  onChange: (next: Person | null) => void;
}) {
  const t = useTranslations("employees");
  const common = useTranslations("common");
  const format = useFormatter();
  const [typed, setTyped] = useState("");
  const asked = useSettled(typed.trim());

  const found = useQuery({
    queryKey: ["employees", "pick", asked],
    enabled: asked !== "",
    queryFn: async () => (await activePage(`&search=${encodeURIComponent(asked)}`)).rows,
  });

  // What the field opens on: nobody opens a picker knowing the exact spelling of a name.
  const opening = useQuery({
    queryKey: ["employees", "pick", "opening", near ?? ""],
    queryFn: async (): Promise<Opening> => {
      const [all, own] = await Promise.all([
        activePage(""),
        near ? activePage(`&departmentId=${encodeURIComponent(near)}`) : Promise.resolve({ rows: [], total: 0 }),
      ]);
      const ownIds = new Set(own.rows.map((one) => one.id));
      return { near: own.rows, rest: all.rows.filter((one) => !ownIds.has(one.id)), total: all.total };
    },
  });

  const searching = asked !== "";
  const first = opening.data;
  const items: (Person | Band)[] = searching
    ? (found.data ?? [])
    : !first
      ? []
      : first.near.length > 0
        ? [
            { value: t("pickNear"), items: first.near },
            ...(first.rest.length > 0 ? [{ value: t("pickEveryone"), items: first.rest }] : []),
          ]
        : first.rest;
  const pending = searching ? found.isFetching : opening.isPending;
  const failed = searching ? found.isError : opening.isError;

  const row = (one: Person) => (
    <Combobox.Item key={one.id} value={one}>
      <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{one.fullName}</span>
          {one.department ? <span className="truncate text-sm text-kumo-subtle">{one.department.name}</span> : null}
        </span>
        <span className="shrink-0 font-mono text-kumo-subtle">{one.code}</span>
      </span>
    </Combobox.Item>
  );

  return (
    <Combobox
      items={items}
      value={value}
      onValueChange={(next) => {
        setTyped("");
        onChange((next as Person | null) ?? null);
      }}
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
          {pending ? (
            <span className="flex items-center gap-2">
              <Loader size={14} />
              {t("pickSearching")}
            </span>
          ) : failed ? (
            common("failed")
          ) : searching ? (
            <span className="flex flex-col gap-1">
              <span className="text-kumo-default">{t("noMatch")}</span>
              <span>{t("pickNoMatchHint")}</span>
            </span>
          ) : (
            <span className="flex flex-col gap-1">
              <span className="text-kumo-default">{t("pickNobody")}</span>
              <span>{t("pickNobodyHint")}</span>
            </span>
          )}
        </Combobox.Empty>
        <Combobox.List>
          {(entry: Person | Band) =>
            isBand(entry) ? (
              <Combobox.Group key={entry.value} items={entry.items}>
                <Combobox.GroupLabel>{entry.value}</Combobox.GroupLabel>
                <Combobox.Collection>{(one: Person) => row(one)}</Combobox.Collection>
              </Combobox.Group>
            ) : (
              row(entry)
            )
          }
        </Combobox.List>
        {!searching && first && first.total > first.near.length + first.rest.length ? (
          <p className="mx-1.5 mt-1 w-0 min-w-[calc(100%-0.75rem)] shrink-0 border-t border-kumo-hairline px-2 pt-2 pb-0.5 text-sm text-kumo-subtle">
            {t("pickMore", { total: format.number(first.total) })}
          </p>
        ) : null}
      </Combobox.Content>
    </Combobox>
  );
}
