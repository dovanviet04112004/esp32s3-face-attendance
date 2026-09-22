"use client";

import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Input } from "@/components/ui/input";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";

const PAGE = 50;

interface TallyPage {
  rows: Tally[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
}

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

  const [asked, setAsked] = useState({ from, to, who: "" });
  const backwards = asked.from >= asked.to;

  // The name filter goes to the roll-up, which pages: filtering here would
  // only ever search the rows already on screen.
  function query(cursor: string): string {
    const span = `from=${new Date(asked.from).toISOString()}&to=${new Date(asked.to).toISOString()}`;
    const needle = asked.who.trim() ? `&search=${encodeURIComponent(asked.who.trim())}` : "";
    return `${span}&take=${PAGE}${needle}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  }

  const rollup = useInfiniteQuery({
    queryKey: ["attendance", asked],
    enabled: !backwards,
    initialPageParam: "",
    queryFn: async ({ pageParam }) =>
      (await api.get<TallyPage>(`/reports/attendance?${query(pageParam)}`)).data,
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const shown = rollup.data?.pages.flatMap((one) => one.rows) ?? [];
  const counted = rollup.data?.pages[0];

  function apply(event: FormEvent): void {
    event.preventDefault();
    setAsked({ from, to, who });
  }

  function clock(iso: string | null) {
    return iso ? format.dateTime(new Date(iso), "medium") : common("empty");
  }

  // A file holds the whole range, not the pages a reader happened to open.
  const exportCsv = useMutation({
    mutationFn: async () => {
      const all: Tally[] = [];
      let cursor = "";
      for (;;) {
        const page = (await api.get<TallyPage>(`/reports/attendance?${query(cursor)}`)).data;
        all.push(...page.rows);
        if (!page.next) {
          break;
        }
        cursor = page.next;
      }
      return all;
    },
    onSuccess: (all) => {
      const head = [t("employee"), t("punches"), t("firstAt"), t("lastAt"), t("unsyncedClock")];
      const body = all.map((row) =>
        [row.fullName, row.punches, row.firstAt ?? "", row.lastAt ?? "", row.unsyncedClock]
          .map(csvCell)
          .join(","),
      );
      // Excel reads a CSV as the system codepage unless the file opens with a BOM,
      // which turns every Vietnamese name into mojibake.
      const blob = new Blob(["\ufeff", [head.map(csvCell).join(","), ...body].join("\r\n")], {
        type: "text/csv;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `attendance-${asked.from}-${asked.to}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    },
  });

  const columns: Column<Tally>[] = [
    {
      id: "employee",
      header: t("employee"),
      sticky: true,
      sortBy: (row) => row.fullName,
      cell: (row) => (
        <Link
          href={`/attendance/${row.employeeId}`}
          className="underline hover:no-underline"
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
        onApply={apply}
        extra={
          <Button
            type="button"
            tone="quiet"
            disabled={shown.length === 0 || exportCsv.isPending}
            onClick={() => exportCsv.mutate()}
          >
            {exportCsv.isPending ? common("loading") : common("export")}
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
            min={from}
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
          more={
            rollup.hasNextPage ? (
              <div className="mt-3 flex flex-col items-center gap-1">
                <Button
                  type="button"
                  tone="quiet"
                  disabled={rollup.isFetchingNextPage}
                  onClick={() => void rollup.fetchNextPage()}
                >
                  {rollup.isFetchingNextPage ? common("loading") : common("loadMore")}
                </Button>
                <p className="text-xs text-(--color-muted) tabular-nums">
                  {common(counted?.totalIsExact === false ? "showingOfAtLeast" : "showingOf", {
                    shown: shown.length,
                    total: counted?.total ?? 0,
                  })}
                </p>
              </div>
            ) : null
          }
        />
      )}
    </section>
  );
}
