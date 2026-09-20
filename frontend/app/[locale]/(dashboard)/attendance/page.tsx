"use client";

import { useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Input } from "@/components/ui/input";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";

interface Tally {
  employeeId: number;
  fullName: string;
  punches: number;
  firstAt: string | null;
  lastAt: string | null;
  unsyncedClock: number;
}

function isoDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export default function AttendancePage() {
  const t = useTranslations("attendance");
  const common = useTranslations("common");
  const format = useFormatter();
  const year = new Date().getFullYear();
  const [from, setFrom] = useState(isoDay(new Date(Date.UTC(year, 0, 1))));
  const [to, setTo] = useState(isoDay(new Date(Date.UTC(year + 1, 0, 1))));
  const [who, setWho] = useState("");

  const backwards = from >= to;
  const rollup = useQuery({
    queryKey: ["attendance", from, to],
    enabled: !backwards,
    queryFn: async () => {
      const span = `from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`;
      return (await api.get<Tally[]>(`/reports/attendance?${span}`)).data;
    },
  });

  const shown = useMemo(() => {
    const needle = who.trim().toLocaleLowerCase();
    const rows = rollup.data ?? [];
    return needle ? rows.filter((row) => row.fullName.toLocaleLowerCase().includes(needle)) : rows;
  }, [rollup.data, who]);

  function clock(iso: string | null) {
    return iso ? format.dateTime(new Date(iso), "medium") : common("empty");
  }

  function exportCsv() {
    const head = [t("employee"), t("punches"), t("firstAt"), t("lastAt"), t("unsyncedClock")];
    const body = shown.map((row) =>
      [row.fullName, row.punches, row.firstAt ?? "", row.lastAt ?? "", row.unsyncedClock]
        .map(csvCell)
        .join(","),
    );
    // Excel reads a CSV as the system codepage unless the file opens with a BOM,
    // which turns every Vietnamese name into mojibake.
    const blob = new Blob(["﻿", [head.map(csvCell).join(","), ...body].join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `attendance-${from}-${to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const columns: Column<Tally>[] = [
    {
      id: "employee",
      header: t("employee"),
      sticky: true,
      sortBy: (row) => row.fullName,
      cell: (row) => (
        <Link
          href={`/attendance/${row.employeeId}`}
          className="text-(--color-accent) hover:underline"
        >
          {row.fullName}
        </Link>
      ),
    },
    {
      id: "punches",
      header: t("punches"),
      numeric: true,
      sortBy: (row) => row.punches,
      cell: (row) => row.punches,
    },
    { id: "firstAt", header: t("firstAt"), cell: (row) => clock(row.firstAt) },
    { id: "lastAt", header: t("lastAt"), cell: (row) => clock(row.lastAt) },
    {
      id: "unsyncedClock",
      header: t("unsyncedClock"),
      numeric: true,
      sortBy: (row) => row.unsyncedClock,
      cell: (row) =>
        row.unsyncedClock > 0 ? (
          <span className="text-(--color-danger)">{row.unsyncedClock}</span>
        ) : (
          <span className="text-(--color-muted)">0</span>
        ),
    },
  ];

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-(--color-muted)">{t("lead")}</p>

      <div className="mt-6" />
      <FilterBar
        extra={
          <Button type="button" tone="quiet" disabled={shown.length === 0} onClick={exportCsv}>
            {common("export")}
          </Button>
        }
      >
        <div>
          <label className="block text-xs text-(--color-muted)" htmlFor="from">
            {t("from")}
          </label>
          <Input
            id="from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="mt-1 w-40"
          />
        </div>
        <div>
          <label className="block text-xs text-(--color-muted)" htmlFor="to">
            {t("to")}
          </label>
          <Input
            id="to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="mt-1 w-40"
          />
        </div>
        <div>
          <label className="block text-xs text-(--color-muted)" htmlFor="who">
            {t("employee")}
          </label>
          <Input
            id="who"
            value={who}
            placeholder={common("search")}
            onChange={(e) => setWho(e.target.value)}
            className="mt-1 w-56"
          />
        </div>
      </FilterBar>

      {backwards ? (
        <p role="alert" className="text-sm text-(--color-danger)">
          {t("badRange")}
        </p>
      ) : (
        <DataTable
          id="attendance-rollup"
          columns={columns}
          rows={shown}
          keyOf={(row) => String(row.employeeId)}
          pending={rollup.isPending}
          failed={rollup.isError}
          onRetry={() => rollup.refetch()}
          empty={t("rangeEmpty")}
        />
      )}
    </section>
  );
}
