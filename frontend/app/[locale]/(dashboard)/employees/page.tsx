"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { DataTable, type Column } from "@/components/tables/data-table";
import { useRef, useState, type ChangeEvent } from "react";

import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";

interface Employee {
  id: number;
  code: string;
  fullName: string;
  department: { id: string; name: string } | null;
  active: boolean;
}

interface ImportFault {
  row: number;
  column: string;
  code: string;
  value: string;
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
  const role = useSession((s) => s.role);
  const mayWrite = role === "ADMIN" || role === "HR";
  const cache = useQueryClient();
  const faultOf = useFault();
  const picker = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [fault, setFault] = useState<string | null>(null);

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
  const employees = useQuery({
    queryKey: ["employees"],
    queryFn: async () =>
      (await api.get<{ rows: Employee[]; total: number; totalIsExact?: boolean }>("/employees"))
        .data,
  });

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
            {employees.data
              ? t(employees.data.totalIsExact === false ? "countAtLeast" : "count", {
                  count: employees.data.total,
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
      <DataTable
        id="employees"
        columns={columns}
        rows={employees.data?.rows}
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
    </section>
  );
}
