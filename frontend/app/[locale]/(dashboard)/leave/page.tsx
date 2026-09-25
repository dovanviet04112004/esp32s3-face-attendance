"use client";

import { Banner, Button } from "@cloudflare/kumo";
import { DownloadSimpleIcon, InfoIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { Suspense, useEffect, useMemo, useState } from "react";

import {
  StatePill,
  useRequestWords,
  type RequestKind,
  type RequestRow,
  type RequestState,
} from "@/components/requests/request-card";
import { REQUEST_KINDS } from "@/components/requests/request-form";
import { DataTable, PersonCell, type Column } from "@/components/tables/data-table";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { useNotify } from "@/components/ui/notify";
import { PageHeader, PageLayout } from "@/components/ui/page";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useUrlState } from "@/lib/url-state";

const STATES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const;
const kPage = 50;
const DEFAULTS = { q: "", kind: "", state: "", dept: "", from: "", to: "", sort: "", dir: "" };

interface RequestPage {
  rows: RequestRow[];
  total: number;
  totalIsExact?: boolean;
  next?: string | null;
}

interface Department {
  id: string;
  name: string;
}

function query(params: Record<string, string>): string {
  return new URLSearchParams(Object.entries(params).filter(([, value]) => value !== "")).toString();
}

function save(text: string, name: string): void {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

function Register() {
  const t = useTranslations("requests");
  const common = useTranslations("common");
  const format = useFormatter();
  const words = useRequestWords();
  const notify = useNotify();
  // Every state by default: filtering to pending here would repeat the
  // approvals inbox under a second sidebar entry (KEHOACH 9.15).
  const [url, setUrl] = useUrlState(DEFAULTS);
  const [typed, setTyped] = useState(url.q);
  const settled = useSettled(typed.trim());

  useEffect(() => {
    if (settled !== url.q) {
      setUrl({ q: settled });
    }
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps

  const filter = useMemo(
    () => ({ search: url.q, kind: url.kind, departmentId: url.dept, from: url.from, to: url.to }),
    [url.q, url.kind, url.dept, url.from, url.to],
  );
  const order = { sort: url.sort || "createdAt", order: url.dir || "desc" };

  const rows = useInfiniteQuery({
    queryKey: ["requests", "register", filter, url.state, order],
    initialPageParam: "",
    queryFn: async ({ pageParam }) =>
      (await api.get<RequestPage>(`/requests?${query({ ...filter, state: url.state, ...order, take: String(kPage), cursor: pageParam })}`)).data,
    getNextPageParam: (last) => last.next ?? undefined,
  });

  // One row asked per state, the total read off each page, so the options carry their counts.
  const counts = useQuery({
    queryKey: ["requests", "register", "counts", filter],
    queryFn: async () => {
      const count = async (state: string) =>
        (await api.get<RequestPage>(`/requests?${query({ ...filter, state, take: "1" })}`)).data.total;
      const [all, ...each] = await Promise.all([count(""), ...STATES.map(count)]);
      return { "": all, ...Object.fromEntries(STATES.map((one, at) => [one, each[at] ?? 0])) } as Record<string, number>;
    },
  });

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Department[]>("/departments")).data,
  });

  // Nobody can file leave until the desk declares a type (KEHOACH 9.5).
  const role = useSession((held) => held.role);
  const router = useRouter();
  const declares = role === "HR" || role === "ADMIN";
  const types = useQuery({
    queryKey: ["leave-types"],
    enabled: declares,
    queryFn: async () => (await api.get<{ id: string }[]>("/leave-types")).data,
  });

  const download = useMutation({
    mutationFn: async () =>
      save((await api.get<string>(`/requests/export?${query({ ...filter, state: url.state, ...order })}`)).data, "requests.csv"),
    onSuccess: () => notify.done(t("exported")),
    onError: notify.failed,
  });

  const shown = rows.data?.pages.flatMap((one) => one.rows);
  const first = rows.data?.pages[0];
  const filtered = Object.values(filter).some((one) => one !== "") || url.state !== "";

  const columns: Column<RequestRow>[] = [
    {
      id: "who",
      header: t("who"),
      cell: (row) => <PersonCell name={row.employee?.fullName ?? common("empty")} code={row.employee?.code} />,
    },
    {
      id: "department",
      header: t("department"),
      priority: 3,
      truncate: true,
      maxWidthPx: 180,
      cell: (row) => row.employee?.department?.name ?? common("empty"),
    },
    {
      id: "request",
      header: t("request"),
      sortKey: "fromDate",
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate">{words.kind(row)}</span>
          <span className="text-sm whitespace-nowrap text-kumo-subtle tabular-nums">{words.span(row)}</span>
        </div>
      ),
    },
    { id: "extent", header: t("extent"), numeric: true, priority: 2, cell: (row) => words.extent(row) },
    { id: "state", header: t("state"), cell: (row) => <StatePill state={row.state} /> },
    {
      id: "filed",
      header: t("filed"),
      priority: 2,
      sortKey: "createdAt",
      cell: (row) => <span className="whitespace-nowrap tabular-nums">{format.dateTime(new Date(row.createdAt), "day")}</span>,
    },
    {
      id: "decidedBy",
      header: t("decidedBy"),
      priority: 3,
      cell: (row) =>
        row.decidedBy ? (
          <div className="flex min-w-0 flex-col">
            <span className="truncate">{row.decidedBy.fullName ?? row.decidedBy.email}</span>
            {row.decidedAt ? (
              <span className="text-sm text-kumo-subtle tabular-nums">{format.dateTime(new Date(row.decidedAt), "day")}</span>
            ) : null}
          </div>
        ) : (
          common("empty")
        ),
    },
  ];

  return (
    <>
      <PageHeader title={t("registerTitle")} description={t("deskLead")} />

      <PageLayout>
        {declares && types.data?.length === 0 ? (
          <Banner
            variant="alert"
            className="mb-4"
            icon={<InfoIcon weight="fill" />}
            title={t("noLeaveTypesDeskTitle")}
            description={t("noLeaveTypesDeskLead")}
            action={
              <Banner.Action variant="secondary" onClick={() => router.push("/leave-types")}>
                {t("noLeaveTypesDeskGo")}
              </Banner.Action>
            }
          />
        ) : null}
        <FilterBar
          search={{ value: typed, onChange: setTyped, placeholder: t("registerSearch") }}
          filters={[
            {
              key: "kind",
              label: t("kind"),
              value: url.kind,
              onChange: (next) => setUrl({ kind: next }),
              items: { "": t("anyKind"), ...Object.fromEntries(REQUEST_KINDS.map((one: RequestKind) => [one, t(`kind${one}`)])) },
            },
            {
              key: "state",
              label: t("state"),
              value: url.state,
              onChange: (next) => setUrl({ state: next }),
              items: { "": t("anyState"), ...Object.fromEntries(STATES.map((one) => [one, t(`count${one}`)])) },
              counts: counts.data,
            },
            {
              key: "dept",
              label: t("department"),
              value: url.dept,
              searchable: true,
              onChange: (next) => setUrl({ dept: next }),
              items: { "": t("anyDepartment"), ...Object.fromEntries((departments.data ?? []).map((one) => [one.id, one.name])) },
            },
          ]}
          range={{ from: url.from, to: url.to, onFrom: (next) => setUrl({ from: next }), onTo: (next) => setUrl({ to: next }) }}
          extra={
            <Button variant="secondary" icon={DownloadSimpleIcon} loading={download.isPending} onClick={() => download.mutate()}>
              {common("export")}
            </Button>
          }
        />
        <DataTable
          id="requests"
          cardLead="who"
          cardTrailing="state"
          columns={columns}
          rows={shown}
          keyOf={(row) => row.id}
          pending={rows.isPending}
          failed={rows.isError}
          onRetry={() => void rows.refetch()}
          rowHref={(row) => `/leave/${row.id}`}
          sort={{ key: order.sort, dir: order.order === "asc" ? "asc" : "desc" }}
          onSortChange={(next) => setUrl({ sort: next.key === "createdAt" ? "" : next.key, dir: next.dir === "desc" ? "" : next.dir })}
          empty={filtered ? t("registerNoMatch") : t("registerEmpty")}
          emptyHint={filtered ? t("registerNoMatchHint") : undefined}
          paging={
            first
              ? {
                  shown: shown?.length ?? 0,
                  total: first.total,
                  exact: first.totalIsExact !== false,
                  onMore: rows.hasNextPage ? () => void rows.fetchNextPage() : undefined,
                  loading: rows.isFetchingNextPage,
                }
              : undefined
          }
        />
      </PageLayout>
    </>
  );
}

// The filters ride on the query string, which the prerender does not have.
export default function RequestRegisterPage() {
  return (
    <Suspense>
      <Register />
    </Suspense>
  );
}
