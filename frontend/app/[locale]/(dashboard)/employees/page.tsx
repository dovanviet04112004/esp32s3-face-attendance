"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";

import { DataTable, type Column } from "@/components/tables/data-table";
import { useRef, useState, type ChangeEvent } from "react";

import { Button } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { money } from "@/lib/format";

interface Employee {
  id: number;
  code: string;
  fullName: string;
  department: { id: string; name: string } | null;
  active: boolean;
}

interface EmployeePage {
  rows: Employee[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
}

interface ImportFault {
  row: number;
  column: string;
  code: string;
  value: string;
}

interface Named {
  id: string;
  code: string;
  name: string;
}

interface RaisePreview {
  employeeId: number;
  code: string;
  fullName: string;
  currentBase: string;
  nextBase: string;
}

function firstOfNextMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10);
}

interface ImportReport {
  applied: boolean;
  rows: number;
  toCreate: number;
  toUpdate: number;
  faults: ImportFault[];
}

export default function EmployeesPage() {
  const t = useTranslations("employees");
  const common = useTranslations("common");
  const locale = useLocale();
  const role = useSession((s) => s.role);
  const mayWrite = role === "ADMIN" || role === "HR";
  const cache = useQueryClient();
  const [search, setSearch] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  // A keystroke is not a query: 5000 rows go out only when the filter is run.
  const [asked, setAsked] = useState({ search: "", departmentId: "" });
  const faultOf = useFault();
  const picker = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [raising, setRaising] = useState(false);
  const [raiseFault, setRaiseFault] = useState<string | null>(null);
  const [raiseDept, setRaiseDept] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(firstOfNextMonth);
  const [percent, setPercent] = useState("");
  const [flat, setFlat] = useState("");
  const paysPeople = role === "ADMIN" || role === "PAYROLL";

  const check = useMutation({
    mutationFn: async (text: string) =>
      (await api.post<ImportReport>("/employees/import", { csv: text })).data,
    onSuccess: (seen) => setReport(seen),
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const apply = useMutation({
    mutationFn: async () =>
      (await api.post<ImportReport>("/employees/import?apply=true", { csv })).data,
    onSuccess: (seen) => {
      setReport(seen);
      void cache.invalidateQueries({ queryKey: ["employees"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const download = useMutation({
    mutationFn: async () => {
      const file = (await api.get<string>("/employees/export")).data;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([file], { type: "text/csv;charset=utf-8" }));
      link.download = "employees.csv";
      link.click();
      URL.revokeObjectURL(link.href);
    },
  });

  const departments = useQuery({
    queryKey: ["departments"],
    enabled: raising,
    queryFn: async () => (await api.get<Named[]>("/departments")).data,
  });

  const raise = useMutation({
    mutationFn: async (apply: boolean) => {
      const body = {
        departmentId: raiseDept || undefined,
        effectiveFrom,
        percentBp: percent ? Math.round(Number(percent) * 100) : undefined,
        amount: flat ? Number(flat) : undefined,
        reason: "ANNUAL_REVIEW",
      };
      if (!apply) {
        const rows = (await api.post<RaisePreview[]>("/compensation/bulk/preview", body)).data;
        return { preview: rows, written: null as number | null };
      }
      const done = (await api.post<{ written: number }>("/compensation/bulk", body)).data;
      return { preview: [] as RaisePreview[], written: done.written };
    },
    onError: (fell: unknown) => setRaiseFault(faultOf(fell)),
  });

  const template = useMutation({
    mutationFn: async () => {
      const file = (await api.get<string>("/employees/import/template")).data;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([file], { type: "text/csv;charset=utf-8" }));
      link.download = "employees-template.csv";
      link.click();
      URL.revokeObjectURL(link.href);
    },
  });

  function takeFile(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setFault(null);
    void file.text().then((text) => {
      setCsv(text);
      check.mutate(text);
    });
  }
  const employees = useInfiniteQuery({
    queryKey: ["employees", asked],
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      if (asked.search) {
        params.set("search", asked.search);
      }
      if (asked.departmentId) {
        params.set("departmentId", asked.departmentId);
      }
      if (pageParam) {
        params.set("cursor", pageParam);
      }
      const query = params.toString();
      return (await api.get<EmployeePage>(`/employees${query ? `?${query}` : ""}`)).data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const loaded = employees.data?.pages.flatMap((one) => one.rows);
  const counted = employees.data?.pages[0];

  const columns: Column<Employee>[] = [
    {
      id: "code",
      header: t("code"),
      sticky: true,
      sortBy: (row) => row.code,
      cell: (row) => <span className="font-mono">{row.code}</span>,
    },
    { id: "fullName", header: t("fullName"), sortBy: (row) => row.fullName, cell: (row) => row.fullName },
    {
      id: "department",
      header: t("department"),
      sortBy: (row) => row.department?.name ?? "",
      cell: (row) => row.department?.name ?? common("empty"),
    },
    {
      id: "status",
      header: t("status"),
      sortBy: (row) => (row.active ? 1 : 0),
      cell: (row) => (
        <span className={row.active ? "text-(--color-ok)" : "text-(--color-muted)"}>
          {row.active ? t("working") : t("left")}
        </span>
      ),
    },
  ];

  if (mayWrite) {
    columns.push({
      id: "edit",
      header: "",
      cell: (row) => (
        <Link
          href={`/employees/${row.id}`}
          className="text-(--color-accent) hover:underline"
        >
          {t("edit")}
        </Link>
      ),
    });
  }

  return (
    <section>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-lg font-semibold">{t("title")}</h1>
          <p className="mt-1 mb-6 text-sm text-(--color-muted)">
            {counted
              ? t(counted.totalIsExact === false ? "countAtLeast" : "count", {
                  count: counted.total,
                })
              : " "}
          </p>
        </div>
        {mayWrite ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" tone="quiet" disabled={download.isPending} onClick={() => download.mutate()}>
              {t("export")}
            </Button>
            <Button size="sm" tone="quiet" onClick={() => picker.current?.click()}>
              {t("import")}
            </Button>
            <Button
              size="sm"
              tone="quiet"
              disabled={template.isPending}
              onClick={() => template.mutate()}
            >
              {t("importTemplate")}
            </Button>
            {paysPeople ? (
              <Button
                size="sm"
                tone="quiet"
                onClick={() => {
                  raise.reset();
                  setRaising(true);
                }}
              >
                {t("raiseAction")}
              </Button>
            ) : null}
            <input
              ref={picker}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={takeFile}
            />
            <Link href="/employees/new">
              <Button size="sm">{t("new")}</Button>
            </Link>
          </div>
        ) : null}
      </div>

      {fault ? (
        <p role="alert" className="mb-4 text-sm text-(--color-danger)">
          {fault}
        </p>
      ) : null}

      {report ? (
        <div className="mb-6 rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
          <p className="text-sm">
            {report.applied
              ? t("importDone", { created: report.toCreate, updated: report.toUpdate })
              : t("importDry", {
                  rows: report.rows,
                  created: report.toCreate,
                  updated: report.toUpdate,
                })}
          </p>
          {report.faults.length ? (
            <>
              <p className="mt-2 text-sm text-(--color-danger)">
                {t("importFaults", { n: report.faults.length })}
              </p>
              <ul className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto font-mono text-xs">
                {report.faults.slice(0, 100).map((one) => (
                  <li key={`${one.row}-${one.column}-${one.code}`} className="flex flex-wrap gap-x-3">
                    <span className="tabular-nums">{t("importLine", { n: one.row })}</span>
                    <span className="min-w-32">{one.column}</span>
                    <span className="text-(--color-danger)">{one.code}</span>
                    <span className="min-w-0 flex-1 truncate text-(--color-muted)">{one.value}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : report.applied ? null : (
            <Button className="mt-3" disabled={apply.isPending} onClick={() => apply.mutate()}>
              {apply.isPending ? common("saving") : t("importApply")}
            </Button>
          )}
        </div>
      ) : null}
      <FilterBar
        onApply={(event) => {
          event.preventDefault();
          setAsked({ search, departmentId });
        }}
      >
        <div>
          <label className="block text-xs text-(--color-muted)" htmlFor="who">
            {common("search")}
          </label>
          <Input
            id="who"
            value={search}
            placeholder={t("searchHint")}
            onChange={(event) => setSearch(event.target.value)}
            className="mt-1 w-56"
          />
        </div>
        <div>
          <label className="block text-xs text-(--color-muted)" htmlFor="inDept">
            {t("department")}
          </label>
          <Select
            id="inDept"
            value={departmentId}
            onChange={(event) => setDepartmentId(event.target.value)}
            className="mt-1 w-56"
          >
            <option value="">{t("anyDepartment")}</option>
            {(departments.data ?? []).map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </Select>
        </div>
      </FilterBar>

      <DataTable
        id="employees"
        columns={columns}
        rows={loaded}
        keyOf={(row) => String(row.id)}
        pending={employees.isPending}
        failed={employees.isError}
        onRetry={() => employees.refetch()}
        emptyHint={t("emptyHint")}
        emptyAction={
          mayWrite ? (
            <Link href="/employees/new">
              <Button size="sm">{t("new")}</Button>
            </Link>
          ) : undefined
        }
      />

      {employees.hasNextPage ? (
        <div className="mt-3 flex flex-col items-center gap-1">
          <Button
            type="button"
            tone="quiet"
            disabled={employees.isFetchingNextPage}
            onClick={() => void employees.fetchNextPage()}
          >
            {employees.isFetchingNextPage ? common("loading") : common("loadMore")}
          </Button>
          {counted ? (
            <p className="text-xs text-(--color-muted) tabular-nums">
              {common("showingOf", { shown: loaded?.length ?? 0, total: counted.total })}
            </p>
          ) : null}
        </div>
      ) : null}

      <Sheet
        open={raising}
        onClose={() => setRaising(false)}
        title={t("raiseAction")}
        closeLabel={common("close")}
        className="sm:max-w-2xl"
      >
        <p className="text-sm text-(--color-muted)">{t("raiseLead")}</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-xs text-(--color-muted)" htmlFor="raiseDept">
              {t("raiseDept")}
            </label>
            <Select
              id="raiseDept"
              value={raiseDept}
              onChange={(event) => setRaiseDept(event.target.value)}
              className="mt-1"
            >
              <option value="">{t("raiseEveryone")}</option>
              {(departments.data ?? []).map((one) => (
                <option key={one.id} value={one.id}>
                  {one.code} · {one.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="block text-xs text-(--color-muted)" htmlFor="raiseFrom">
              {t("raiseFrom")}
            </label>
            <Input
              id="raiseFrom"
              type="date"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <label className="block text-xs text-(--color-muted)" htmlFor="raisePercent">
              {t("raisePercent")}
            </label>
            <Input
              id="raisePercent"
              type="number"
              min={0}
              step="0.1"
              value={percent}
              onChange={(event) => {
                setPercent(event.target.value);
                setFlat("");
              }}
              className="mt-1"
            />
          </div>
          <div>
            <label className="block text-xs text-(--color-muted)" htmlFor="raiseFlat">
              {t("raiseFlat")}
            </label>
            <Input
              id="raiseFlat"
              type="number"
              min={0}
              value={flat}
              onChange={(event) => {
                setFlat(event.target.value);
                setPercent("");
              }}
              className="mt-1"
            />
          </div>
        </div>
        <p className="mt-1 text-xs text-(--color-muted)">{t("raiseEitherHint")}</p>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            tone="quiet"
            disabled={raise.isPending || (percent === "" && flat === "")}
            onClick={() => {
              setRaiseFault(null);
              raise.mutate(false);
            }}
          >
            {raise.isPending ? common("loading") : t("raisePreview")}
          </Button>
          <Button
            type="button"
            tone="danger"
            disabled={raise.isPending || !raise.data || raise.data.preview.length === 0}
            onClick={() => {
              setRaiseFault(null);
              raise.mutate(true);
            }}
          >
            {t("raiseApply")}
          </Button>
        </div>

        {raiseFault ? (
          <p role="alert" className="mt-3 text-sm text-(--color-danger)">
            {raiseFault}
          </p>
        ) : null}

        {raise.data?.written !== null && raise.data?.written !== undefined ? (
          <p className="mt-3 text-sm text-(--color-ok)">
            {t("raiseWritten", { count: raise.data.written })}
          </p>
        ) : null}

        {raise.data && raise.data.preview.length > 0 ? (
          <div className="mt-3 text-sm">
            <p className="text-(--color-warn)">
              {t("raiseWouldWrite", { count: raise.data.preview.length })}
            </p>
            <ul className="mt-2 flex max-h-64 flex-col overflow-y-auto">
              {raise.data.preview.slice(0, 50).map((one) => (
                <li
                  key={one.employeeId}
                  className="flex flex-wrap gap-x-3 border-b border-(--color-line) py-1.5 text-xs last:border-0"
                >
                  <span className="font-mono">{one.code}</span>
                  <span className="min-w-0 flex-1 truncate">{one.fullName}</span>
                  <span className="tabular-nums text-(--color-muted)">
                    {money(Number(one.currentBase), locale)} → {money(Number(one.nextBase), locale)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Sheet>
    </section>
  );
}
