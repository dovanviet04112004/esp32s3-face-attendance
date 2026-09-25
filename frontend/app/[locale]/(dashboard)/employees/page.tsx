"use client";

import { Button, Input, LayerDialog, LinkButton, Select } from "@cloudflare/kumo";
import {
  DownloadSimpleIcon,
  FileArrowDownIcon,
  PlusIcon,
  TrendUpIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Suspense, useRef, useState, type ChangeEvent } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, PageHeader, PageLayout, StatList } from "@/components/ui/page";
import { CountPill, StatePill } from "@/components/ui/pill";
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

interface ImportReport {
  applied: boolean;
  rows: number;
  toCreate: number;
  toUpdate: number;
  faults: ImportFault[];
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

interface Expiring {
  contractId: string;
  employeeId: number;
  fullName: string;
  daysLeft: number;
}

interface Attention {
  contractsEnding: { rows: Expiring[]; total: number };
  probationEnding: { rows: Expiring[]; total: number };
}

type Standing = "true" | "false" | "";

const ATTENTION_DESK = ["ADMIN", "HR", "PAYROLL"];
const kDueShown = 3;

function firstOfNextMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

function save(text: string, name: string): void {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

function query(params: Record<string, string>): string {
  const kept = Object.entries(params).filter(([, value]) => value !== "");
  return kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
}

function DueList({ title, rows, total }: { title: string; rows: Expiring[]; total: number }) {
  const t = useTranslations("overview");
  if (total === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="flex items-center justify-between font-medium">
        {title}
        <CountPill>{total}</CountPill>
      </p>
      <ul className="flex flex-col">
        {rows.slice(0, kDueShown).map((row) => (
          <li key={row.contractId} className="flex items-center justify-between gap-3 py-1">
            <Link href={`/employees/${row.employeeId}?tab=contracts`} className="min-w-0 truncate text-kumo-link hover:underline">
              {row.fullName}
            </Link>
            <span className="shrink-0 text-kumo-subtle tabular-nums">{t("daysLeft", { count: row.daysLeft })}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Directory() {
  const t = useTranslations("employees");
  const common = useTranslations("common");
  const locale = useLocale();
  const role = useSession((s) => s.role);
  const mayWrite = role === "ADMIN" || role === "HR";
  const paysPeople = role === "ADMIN" || role === "PAYROLL";
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();
  const picker = useRef<HTMLInputElement>(null);

  const [typed, setTyped] = useState("");
  const search = useSettled(typed.trim());
  const asked = useSearchParams();
  // Other pages link here filtered: a department from the org chart, the people who left.
  const [departmentId, setDepartmentId] = useState(() => asked.get("departmentId") ?? "");
  const [active, setActive] = useState<Standing>(() => {
    const held = asked.get("active");
    return held === "false" || held === "" ? held : "true";
  });

  const [csv, setCsv] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [importFault, setImportFault] = useState<string | null>(null);
  const [raising, setRaising] = useState(false);
  const [raiseDept, setRaiseDept] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(firstOfNextMonth);
  const [percent, setPercent] = useState("");
  const [flat, setFlat] = useState("");

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Named[]>("/departments")).data,
  });

  const employees = useInfiniteQuery({
    queryKey: ["employees", { search, departmentId, active }],
    initialPageParam: "",
    queryFn: async ({ pageParam }) =>
      (await api.get<EmployeePage>(`/employees${query({ search, departmentId, active, cursor: pageParam })}`)).data,
    getNextPageParam: (last) => last.next ?? undefined,
  });

  // Totals only: one row asked, the count read off the page.
  const counts = useQuery({
    queryKey: ["employees", "counts", departmentId],
    queryFn: async () => {
      const count = async (standing: Standing) =>
        (await api.get<EmployeePage>(`/employees${query({ departmentId, active: standing, take: "1" })}`)).data;
      const [working, left] = await Promise.all([count("true"), count("false")]);
      return { working: working.total, left: left.total, exact: working.totalIsExact !== false };
    },
  });

  const attention = useQuery({
    queryKey: ["reports", "attention"],
    enabled: role !== null && ATTENTION_DESK.includes(role),
    queryFn: async () => (await api.get<Attention>("/reports/attention")).data,
  });

  const check = useMutation({
    mutationFn: async (text: string) => (await api.post<ImportReport>("/employees/import", { csv: text })).data,
    onSuccess: (seen) => setReport(seen),
    onError: (fell: unknown) => setImportFault(faultOf(fell)),
  });

  const apply = useMutation({
    mutationFn: async () => (await api.post<ImportReport>("/employees/import?apply=true", { csv })).data,
    onSuccess: (done) => {
      setReport(null);
      notify.done(t("importDone", { created: done.toCreate, updated: done.toUpdate }));
      void cache.invalidateQueries({ queryKey: ["employees"] });
    },
    onError: (fell: unknown) => setImportFault(faultOf(fell)),
  });

  const download = useMutation({
    mutationFn: async () => save((await api.get<string>("/employees/export")).data, "employees.csv"),
    onError: notify.failed,
  });

  const template = useMutation({
    mutationFn: async () => save((await api.get<string>("/employees/import/template")).data, "employees-template.csv"),
    onError: notify.failed,
  });

  const raise = useMutation({
    mutationFn: async (write: boolean) => {
      const body = {
        departmentId: raiseDept || undefined,
        effectiveFrom,
        percentBp: percent ? Math.round(Number(percent) * 100) : undefined,
        amount: flat ? Number(flat) : undefined,
        reason: "ANNUAL_REVIEW",
      };
      if (!write) {
        return { preview: (await api.post<RaisePreview[]>("/compensation/bulk/preview", body)).data, written: null };
      }
      return { preview: [] as RaisePreview[], written: (await api.post<{ written: number }>("/compensation/bulk", body)).data.written };
    },
    onSuccess: (done) => {
      if (done.written !== null) {
        setRaising(false);
        notify.done(t("raiseWritten", { count: done.written }));
      }
    },
    onError: notify.failed,
  });

  function takeFile(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    setImportFault(null);
    setReport(null);
    void file.text().then((text) => {
      setCsv(text);
      check.mutate(text);
    });
  }

  const loaded = employees.data?.pages.flatMap((one) => one.rows);
  const first = employees.data?.pages[0];
  const departmentItems: Record<string, string> = {
    "": t("anyDepartment"),
    ...Object.fromEntries((departments.data ?? []).map((one) => [one.id, one.name])),
  };

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
      cell: (row) => <StatePill tone={row.active ? "good" : "idle"}>{row.active ? t("statusWorking") : t("statusLeft")}</StatePill>,
    },
  ];

  const due = attention.data;
  const tools = mayWrite || paysPeople;

  return (
    <>
      <PageHeader
        title={t("directoryTitle")}
        description={t("directoryLead")}
        actions={
          mayWrite ? (
            <LinkButton href="/employees/new" variant="primary" icon={PlusIcon}>
              {t("new")}
            </LinkButton>
          ) : undefined
        }
      />

      <PageLayout
        aside={
          <>
            <AsideCard title={t("summaryTitle")}>
              <StatList
                stats={[
                  {
                    key: "working",
                    label: t("statusWorking"),
                    value: counts.data?.working ?? common("empty"),
                    active: active === "true",
                    onPick: () => setActive("true"),
                  },
                  {
                    key: "left",
                    label: t("statusLeft"),
                    value: counts.data?.left ?? common("empty"),
                    active: active === "false",
                    onPick: () => setActive("false"),
                  },
                  {
                    key: "all",
                    label: common("all"),
                    value: counts.data ? counts.data.working + counts.data.left : common("empty"),
                    active: active === "",
                    onPick: () => setActive(""),
                  },
                ]}
              />
            </AsideCard>
            {due && (due.probationEnding.total > 0 || due.contractsEnding.total > 0) ? (
              <AsideCard
                title={t("dueTitle")}
                action={
                  <Link href="/overview" className="text-sm font-normal text-kumo-link hover:underline">
                    {common("seeAll")}
                  </Link>
                }
              >
                <div className="flex flex-col gap-3">
                  <DueList title={t("probationDue")} rows={due.probationEnding.rows} total={due.probationEnding.total} />
                  <DueList title={t("contractDue")} rows={due.contractsEnding.rows} total={due.contractsEnding.total} />
                </div>
              </AsideCard>
            ) : null}
          </>
        }
        extra={
          tools ? (
            <AsideCard title={common("tools")}>
              <div className="flex flex-col gap-2">
                <Button variant="secondary" icon={DownloadSimpleIcon} loading={download.isPending} onClick={() => download.mutate()} className="w-full justify-start">
                  {t("export")}
                </Button>
                {mayWrite ? (
                  <>
                    <Button variant="secondary" icon={UploadSimpleIcon} loading={check.isPending} onClick={() => picker.current?.click()} className="w-full justify-start">
                      {t("import")}
                    </Button>
                    <Button variant="secondary" icon={FileArrowDownIcon} loading={template.isPending} onClick={() => template.mutate()} className="w-full justify-start">
                      {t("importTemplate")}
                    </Button>
                  </>
                ) : null}
                {paysPeople ? (
                  <Button
                    variant="secondary"
                    icon={TrendUpIcon}
                    className="w-full justify-start"
                    onClick={() => {
                      raise.reset();
                      setRaising(true);
                    }}
                  >
                    {t("raiseAction")}
                  </Button>
                ) : null}
              </div>
              <input ref={picker} type="file" accept=".csv,text/csv" className="hidden" onChange={takeFile} />
            </AsideCard>
          ) : undefined
        }
      >
        <FilterBar
          search={{ value: typed, onChange: setTyped, placeholder: t("searchHint") }}
          filters={[
            { key: "department", label: t("department"), value: departmentId, onChange: setDepartmentId, items: departmentItems },
            {
              key: "status",
              label: t("status"),
              value: active,
              onChange: (next) => setActive(next as Standing),
              items: { true: t("statusWorking"), false: t("statusLeft"), "": common("all") },
            },
          ]}
        />
        <DataTable
          id="employees"
          cardLead="fullName"
          columns={columns}
          rows={loaded}
          keyOf={(row) => String(row.id)}
          pending={employees.isPending}
          failed={employees.isError}
          onRetry={() => void employees.refetch()}
          rowHref={(row) => `/employees/${row.id}`}
          empty={search || departmentId ? t("noMatch") : undefined}
          emptyHint={search || departmentId ? t("noMatchHint") : t("emptyHint")}
          emptyAction={
            mayWrite && !search && !departmentId ? (
              <LinkButton href="/employees/new" variant="primary" icon={PlusIcon}>
                {t("new")}
              </LinkButton>
            ) : undefined
          }
          paging={
            first
              ? {
                  shown: loaded?.length ?? 0,
                  total: first.total,
                  exact: first.totalIsExact,
                  onMore: employees.hasNextPage ? () => void employees.fetchNextPage() : undefined,
                  loading: employees.isFetchingNextPage,
                }
              : undefined
          }
        />
      </PageLayout>

      <LayerDialog.Root
        open={report !== null || importFault !== null}
        onOpenChange={(next) => {
          if (!next) {
            setReport(null);
            setImportFault(null);
          }
        }}
        dismissDisabled={apply.isPending}
      >
        <LayerDialog.Content size="lg" closeLabel={common("close")}>
          <LayerDialog.Title>{t("importCheckTitle")}</LayerDialog.Title>
          <LayerDialog.Description>
            {report ? t("importDry", { rows: report.rows, created: report.toCreate, updated: report.toUpdate }) : importFault}
          </LayerDialog.Description>
          <LayerDialog.Body>
            {report && report.faults.length > 0 ? (
              <>
                <p className="mb-2 text-kumo-danger">{t("importFaults", { n: report.faults.length })}</p>
                <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto font-mono text-sm">
                  {report.faults.slice(0, 100).map((one) => (
                    <li key={`${one.row}-${one.column}-${one.code}`} className="flex flex-wrap gap-x-3">
                      <span className="tabular-nums">{t("importLine", { n: one.row })}</span>
                      <span className="min-w-32">{one.column}</span>
                      <span className="text-kumo-danger">{one.code}</span>
                      <span className="min-w-0 flex-1 truncate text-kumo-subtle">{one.value}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </LayerDialog.Body>
          {report && report.faults.length === 0 ? (
            <LayerDialog.Actions dismissLabel={common("cancel")}>
              <LayerDialog.Actions.Primary loading={apply.isPending} onClick={() => apply.mutate()}>
                {t("importApplyN", { count: report.toCreate + report.toUpdate })}
              </LayerDialog.Actions.Primary>
            </LayerDialog.Actions>
          ) : null}
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Root open={raising} onOpenChange={setRaising} dismissDisabled={raise.isPending}>
        <LayerDialog.Content size="lg" closeLabel={common("close")}>
          <LayerDialog.Title>{t("raiseAction")}</LayerDialog.Title>
          <LayerDialog.Description>{t("raiseLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <div className="grid gap-4 sm:grid-cols-2">
              <Select
                label={t("raiseDept")}
                hideLabel={false}
                value={raiseDept}
                onValueChange={(next) => setRaiseDept(String(next ?? ""))}
                items={{ "": t("raiseEveryone"), ...Object.fromEntries((departments.data ?? []).map((one) => [one.id, `${one.code} · ${one.name}`])) }}
              />
              <Input label={t("raiseFrom")} type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} />
              <Input
                label={t("raisePercent")}
                type="number"
                min={0}
                step="0.1"
                value={percent}
                onChange={(event) => {
                  setPercent(event.target.value);
                  setFlat("");
                }}
              />
              <Input
                label={t("raiseFlat")}
                type="number"
                min={0}
                value={flat}
                description={t("raiseEitherHint")}
                onChange={(event) => {
                  setFlat(event.target.value);
                  setPercent("");
                }}
              />
            </div>
            <Button
              variant="secondary"
              className="mt-4"
              loading={raise.isPending && raise.variables === false}
              disabled={percent === "" && flat === ""}
              onClick={() => raise.mutate(false)}
            >
              {t("raisePreview")}
            </Button>
            {raise.data && raise.data.preview.length > 0 ? (
              <div className="mt-4">
                <p className="font-medium">{t("raiseWouldWrite", { count: raise.data.preview.length })}</p>
                <ul className="mt-2 flex max-h-64 flex-col overflow-y-auto">
                  {raise.data.preview.slice(0, 50).map((one) => (
                    <li key={one.employeeId} className="flex flex-wrap gap-x-3 border-b border-kumo-hairline py-1.5 last:border-0">
                      <span className="font-mono">{one.code}</span>
                      <span className="min-w-0 flex-1 truncate">{one.fullName}</span>
                      <span className="text-kumo-subtle tabular-nums">
                        {money(Number(one.currentBase), locale)} → {money(Number(one.nextBase), locale)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              loading={raise.isPending && raise.variables === true}
              disabled={!raise.data || raise.data.preview.length === 0}
              onClick={() => raise.mutate(true)}
            >
              {raise.data && raise.data.preview.length > 0 ? t("raiseApplyN", { count: raise.data.preview.length }) : t("raiseApply")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}

// The filters arrive in the query string, which the prerender does not have.
export default function EmployeesPage() {
  return (
    <Suspense>
      <Directory />
    </Suspense>
  );
}
