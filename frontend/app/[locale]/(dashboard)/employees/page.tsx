"use client";

import { Button, Input, LayerDialog, LinkButton, Select } from "@cloudflare/kumo";
import { PlusIcon, TrendUpIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Suspense, useEffect, useState } from "react";

import { useDirectorySelection } from "@/components/employees/bulk";
import { DirectoryFiles } from "@/components/employees/import";
import { LeavingPill } from "@/components/employees/offboard";
import { DataTable, PersonCell, type Column } from "@/components/tables/data-table";
import { DateField } from "@/components/ui/date-field";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, PageHeader, PageLayout } from "@/components/ui/page";
import { CountPill, StatePill } from "@/components/ui/pill";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { dayOnly, money } from "@/lib/format";
import { useUrlState } from "@/lib/url-state";

interface Employee {
  id: number;
  code: string;
  fullName: string;
  hireDate: string | null;
  active: boolean;
  leaveDate: string | null;
  department: { id: string; name: string } | null;
  jobTitle: { id: string; name: string } | null;
  manager: { id: number; code: string; fullName: string } | null;
  endsOn?: string;
}

interface EmployeePage {
  rows: Employee[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
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

const DESK = ["ADMIN", "HR", "PAYROLL"];
const ENDINGS = ["contract", "probation"] as const;
// The window the API assumes when a link names none (ENDING_WINDOW_DAYS in the backend).
const kEndingDays = 30;
const kMsPerDay = 86_400_000;
const kDueShown = 3;

function firstOfNextMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

function queryOf(params: Record<string, string>): string {
  const kept = Object.entries(params).filter(([, value]) => value !== "");
  return kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
}

function DueList({ title, rows, total, onAll }: { title: string; rows: Expiring[]; total: number; onAll: () => void }) {
  const t = useTranslations("overview");
  const common = useTranslations("common");
  if (total === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="flex items-center justify-between gap-2 font-medium">
        <span className="flex items-center gap-2">
          {title}
          <CountPill>{total}</CountPill>
        </span>
        <Button variant="ghost" size="sm" onClick={onAll}>
          {common("seeAll")}
        </Button>
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
  const due = useTranslations("overview");
  const format = useFormatter();
  const locale = useLocale();
  const role = useSession((s) => s.role);
  const mayWrite = role === "ADMIN" || role === "HR";
  const desk = role !== null && DESK.includes(role);
  const cache = useQueryClient();
  const notify = useNotify();

  const [url, setUrl] = useUrlState({ q: "", departmentId: "", active: "true", ending: "", within: "" });
  const [typed, setTyped] = useState(url.q);
  const settled = useSettled(typed.trim());
  useEffect(() => {
    if (settled !== url.q) {
      setUrl({ q: settled });
    }
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps
  const ending = (ENDINGS as readonly string[]).includes(url.ending) ? url.ending : "";
  const windowDays = Number(url.within) > 0 ? Number(url.within) : kEndingDays;
  const filters: Record<string, string> = ending
    ? { search: url.q, departmentId: url.departmentId, ending, within: url.within }
    : { search: url.q, departmentId: url.departmentId, active: url.active };
  const narrowed = url.q !== "" || url.departmentId !== "" || ending !== "";

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
    queryKey: ["employees", "list", filters],
    initialPageParam: "",
    queryFn: async ({ pageParam }) =>
      (await api.get<EmployeePage>(`/employees${queryOf({ ...filters, cursor: pageParam })}`)).data,
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const counts = useQuery({
    queryKey: ["employees", "counts", url.q, url.departmentId],
    queryFn: async () =>
      (await api.get<{ active: number; left: number }>(`/employees/counts${queryOf({ search: url.q, departmentId: url.departmentId })}`))
        .data,
  });

  const attention = useQuery({
    queryKey: ["reports", "attention"],
    enabled: desk,
    queryFn: async () => (await api.get<Attention>("/reports/attention")).data,
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
        void cache.invalidateQueries({ queryKey: ["compensation"] });
        void cache.invalidateQueries({ queryKey: ["reports"] });
        void cache.invalidateQueries({ queryKey: ["employees"] });
      }
    },
    onError: notify.failed,
  });

  const loaded = employees.data?.pages.flatMap((one) => one.rows);
  const first = employees.data?.pages[0];
  const selection = useDirectorySelection<Employee>({
    filter: filters,
    total: first?.total,
    exact: first?.totalIsExact,
    loaded: loaded?.length ?? 0,
    enabled: mayWrite,
  });
  const departmentItems: Record<string, string> = {
    "": t("anyDepartment"),
    ...Object.fromEntries((departments.data ?? []).map((one) => [one.id, one.name])),
  };
  const daysLeftOf = (day: string) => {
    const left = Math.round((dayOnly(day).getTime() - dayOnly(new Date().toISOString().slice(0, 10)).getTime()) / kMsPerDay);
    return left < 0 ? t("overdue") : due("daysLeft", { count: left });
  };

  const statusShown = url.active === "" && !ending;
  const leavesOn = (row: Employee) => (row.active ? row.leaveDate : null);
  const columns: Column<Employee>[] = [
    {
      id: "person",
      header: t("employee"),
      cell: (row) => {
        const leaving = statusShown ? null : leavesOn(row);
        return leaving ? (
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <PersonCell name={row.fullName} code={row.code} />
            <LeavingPill leaveDate={leaving} />
          </span>
        ) : (
          <PersonCell name={row.fullName} code={row.code} />
        );
      },
    },
    ...(ending
      ? [
          {
            id: "endsOn",
            header: ending === "contract" ? t("contractDue") : t("probationDue"),
            cell: (row: Employee) =>
              row.endsOn ? (
                <span className="flex flex-col tabular-nums">
                  <span>{format.dateTime(dayOnly(row.endsOn), "day")}</span>
                  <span className="text-sm text-kumo-subtle">{daysLeftOf(row.endsOn)}</span>
                </span>
              ) : (
                common("empty")
              ),
          },
        ]
      : []),
    {
      id: "department",
      header: t("department"),
      priority: 2,
      truncate: true,
      cell: (row) => row.department?.name ?? common("empty"),
    },
    {
      id: "jobTitle",
      header: t("jobTitle"),
      priority: 2,
      truncate: true,
      cell: (row) => row.jobTitle?.name ?? common("empty"),
    },
    {
      id: "manager",
      header: t("manager"),
      priority: 3,
      truncate: true,
      cell: (row) => row.manager?.fullName ?? common("empty"),
    },
    {
      id: "hireDate",
      header: t("hireDate"),
      priority: 3,
      cell: (row) =>
        row.hireDate ? <span className="tabular-nums">{format.dateTime(dayOnly(row.hireDate), "day")}</span> : common("empty"),
    },
    ...(statusShown
      ? [
          {
            id: "status",
            header: t("status"),
            cell: (row: Employee) => {
              const leaving = leavesOn(row);
              return leaving ? (
                <LeavingPill leaveDate={leaving} />
              ) : (
                <StatePill tone={row.active ? "good" : "idle"}>{row.active ? t("statusWorking") : t("statusLeft")}</StatePill>
              );
            },
          },
        ]
      : []),
  ];

  const dueSoon = attention.data;
  const hasDue = dueSoon !== undefined && (dueSoon.probationEnding.total > 0 || dueSoon.contractsEnding.total > 0);

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
          hasDue ? (
            <AsideCard title={t("dueTitle")}>
              <div className="flex flex-col gap-3">
                <DueList
                  title={t("probationDue")}
                  rows={dueSoon.probationEnding.rows}
                  total={dueSoon.probationEnding.total}
                  onAll={() => setUrl({ ending: "probation", within: "" })}
                />
                <DueList
                  title={t("contractDue")}
                  rows={dueSoon.contractsEnding.rows}
                  total={dueSoon.contractsEnding.total}
                  onAll={() => setUrl({ ending: "contract", within: "" })}
                />
              </div>
            </AsideCard>
          ) : undefined
        }
        extra={
          desk ? (
            <AsideCard title={common("tools")}>
              <div className="flex flex-col gap-2">
                <DirectoryFiles query={queryOf(filters)} filtered={narrowed || url.active !== ""} mayWrite={mayWrite} />
                {mayWrite ? (
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
            </AsideCard>
          ) : undefined
        }
      >
        <FilterBar
          search={{ value: typed, onChange: setTyped, placeholder: t("searchHint") }}
          filters={[
            {
              key: "department",
              label: t("department"),
              value: url.departmentId,
              searchable: true,
              onChange: (next) => setUrl({ departmentId: next }),
              items: departmentItems,
            },
            {
              key: "ending",
              label: t("endingFilter"),
              value: ending,
              onChange: (next) => setUrl({ ending: next, within: "" }),
              items: {
                "": t("endingAny"),
                contract: t("endingContract", { days: windowDays }),
                probation: t("endingProbation", { days: windowDays }),
              },
            },
            ...(ending
              ? []
              : [
                  {
                    key: "status",
                    label: t("status"),
                    value: url.active,
                    onChange: (next: string) => setUrl({ active: next }),
                    items: { true: t("statusWorking"), false: t("statusLeft"), "": common("all") },
                    counts: {
                      true: counts.data?.active,
                      false: counts.data?.left,
                      "": counts.data ? counts.data.active + counts.data.left : undefined,
                    },
                  },
                ]),
          ]}
        />
        <DataTable
          id="employees"
          cardLead="person"
          cardTrailing={ending ? "endsOn" : url.active === "" ? "status" : undefined}
          columns={columns}
          rows={loaded}
          keyOf={(row) => String(row.id)}
          {...selection.table}
          pending={employees.isPending}
          failed={employees.isError}
          onRetry={() => void employees.refetch()}
          rowHref={(row) => `/employees/${row.id}`}
          empty={narrowed ? t("noMatch") : undefined}
          emptyHint={narrowed ? t("noMatchHint") : t("emptyHint")}
          emptyAction={
            mayWrite && !narrowed ? (
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
      {selection.dialog}

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
              <DateField label={t("raiseFrom")} value={effectiveFrom} onChange={setEffectiveFrom} />
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

// The filters live in the query string, which the prerender does not have.
export default function EmployeesPage() {
  return (
    <Suspense>
      <Directory />
    </Suspense>
  );
}
