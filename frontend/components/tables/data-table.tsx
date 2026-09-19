"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  numeric?: boolean;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  keyOf: (row: T) => string;
  pending?: boolean;
  empty?: string;
}

export function DataTable<T>({ columns, rows, keyOf, pending, empty }: Props<T>) {
  const t = useTranslations("common");
  if (pending) {
    return <p className="text-sm text-(--color-muted)">{t("loading")}</p>;
  }
  if (!rows?.length) {
    return <p className="text-sm text-(--color-muted)">{empty ?? t("noData")}</p>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-(--color-line) bg-(--color-surface)">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-(--color-line) text-left text-(--color-muted)">
            {columns.map((column) => (
              <th key={column.header} className="px-4 py-3 font-medium">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={keyOf(row)} className="border-b border-(--color-line) last:border-0">
              {columns.map((column) => (
                <td
                  key={column.header}
                  className={column.numeric ? "px-4 py-3 tabular-nums" : "px-4 py-3"}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
