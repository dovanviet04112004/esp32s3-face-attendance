"use client";

import { Banner, Button } from "@cloudflare/kumo";
import { DownloadSimpleIcon, InfoIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Suspense, useEffect, useMemo, useState } from "react";

import { QUEUE_ROLES, type Queue } from "@/components/nav/waiting-count";
import {
  StatePill,
  useRequestWords,
  type RequestKind,
  type RequestRow,
} from "@/components/requests/request-card";
import { REQUEST_KINDS } from "@/components/requests/request-form";
import {
  AdvancesQueue,
  ChangesQueue,
  DependentsQueue,
  DisputesQueue,
  LETTER_KINDS,
  LettersQueue,
  PROFILE_FIELDS,
  RequestLedgerSheet,
  personColumns,
  useLedgerColumns,
  type LedgerOrder,
} from "@/components/requests/queues";
import { DataTable, type Column } from "@/components/tables/data-table";
import { FilterBar, useSettled, type Filter } from "@/components/ui/filter-bar";
import { useNotify } from "@/components/ui/notify";
import { PageHeader, PageLayout } from "@/components/ui/page";
import { useRouter } from "@/i18n/navigation";
import { api, queryOf, saveCsv } from "@/lib/api";
import { useSession, type Role } from "@/lib/auth";
import { useUrlState } from "@/lib/url-state";

const STATES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const;
const LETTER_STATES = ["REQUESTED", "ISSUED", "REJECTED", "CANCELLED"] as const;
const CHANGE_STATES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const;
const CLAIM_STATES = ["OPEN", "ANSWERED", "WITHDRAWN"] as const;
const DEPENDENT_STATES = ["PENDING", "ACTIVE", "REJECTED", "ENDED"] as const;
const ADVANCE_STATES = ["PENDING", "APPROVED", "PAID", "SETTLED", "REJECTED", "CANCELLED"] as const;
const kPage = 50;
const DEFAULTS = { tab: "", q: "", kind: "", state: "", dept: "", from: "", to: "", sort: "", dir: "", order: "" };
const NO_LINK = { openId: "", onOpened: () => undefined };

type Tab = "requests" | "disputes" | "certificates" | "profileChanges" | "dependents" | "advances";

// The tree-scoped Request ledger answers these roles only, PAYROLL left out (KEHOACH 9.15).
const REQUEST_LEDGER: Role[] = ["ADMIN", "HR", "MANAGER"];

// One tab per table that holds filings, shown to the roles holding its queue (KEHOACH 9.15).
const TABS: { tab: Tab; queues: Queue[] }[] = [
  { tab: "requests", queues: [] },
  { tab: "disputes", queues: ["disputes"] },
  { tab: "certificates", queues: ["certificates"] },
  { tab: "profileChanges", queues: ["profileChanges"] },
  { tab: "dependents", queues: ["dependents"] },
  { tab: "advances", queues: ["advancesToDecide", "advancesToPay"] },
];

const EXPORTS: Record<Tab, { path: string; file: string }> = {
  requests: { path: "/requests/export", file: "requests.csv" },
  disputes: { path: "/payslip-disputes/export", file: "disputes.csv" },
  certificates: { path: "/certificates/export", file: "certificates.csv" },
  profileChanges: { path: "/profile-changes/export", file: "profile-changes.csv" },
  dependents: { path: "/dependents/export", file: "dependents.csv" },
  advances: { path: "/advances/export", file: "advances.csv" },
};

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

function Register() {
  const t = useTranslations("requests");
  const c = useTranslations("certificates");
  const p = useTranslations("profile");
  const d = useTranslations("disputes");
  const me = useTranslations("me");
  const pay = useTranslations("payroll");
  const common = useTranslations("common");
  const words = useRequestWords();
  const notify = useNotify();
  // Every state by default: filtering to pending here would repeat the
  // approvals inbox under a second sidebar entry (KEHOACH 9.15).
  const [url, setUrl] = useUrlState(DEFAULTS);
  const [typed, setTyped] = useState(url.q);
  const [open, setOpen] = useState<RequestRow | null>(null);
  const settled = useSettled(typed.trim());

  useEffect(() => {
    if (settled !== url.q) {
      setUrl({ q: settled });
    }
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps

  const role = useSession((held) => held.role);
  const holds = (one: (typeof TABS)[number]) =>
    role !== null &&
    (one.tab === "requests" ? REQUEST_LEDGER.includes(role) : one.queues.some((queue) => QUEUE_ROLES[queue].includes(role)));
  const shown = TABS.filter(holds);
  const tab: Tab = shown.find((one) => one.tab === url.tab)?.tab ?? shown[0]?.tab ?? "requests";
  const onRequests = tab === "requests";

  const filter = useMemo(
    () => ({ search: url.q, kind: url.kind, departmentId: url.dept, from: url.from, to: url.to }),
    [url.q, url.kind, url.dept, url.from, url.to],
  );
  const order = { sort: url.sort || "createdAt", order: url.dir || "desc" };

  const rows = useInfiniteQuery({
    queryKey: ["requests", "register", filter, url.state, order],
    enabled: onRequests,
    initialPageParam: "",
    queryFn: async ({ pageParam }) =>
      (await api.get<RequestPage>(`/requests${queryOf({ ...filter, state: url.state, ...order, take: String(kPage), cursor: pageParam })}`)).data,
    getNextPageParam: (last) => last.next ?? undefined,
  });

  // One row asked per state, the total read off each page, so the options carry their counts.
  const counts = useQuery({
    queryKey: ["requests", "register", "counts", filter],
    enabled: onRequests,
    queryFn: async () => {
      const count = async (state: string) =>
        (await api.get<RequestPage>(`/requests${queryOf({ ...filter, state, take: "1" })}`)).data.total;
      const [all, ...each] = await Promise.all([count(""), ...STATES.map(count)]);
      return { "": all, ...Object.fromEntries(STATES.map((one, at) => [one, each[at] ?? 0])) } as Record<string, number>;
    },
  });

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Department[]>("/departments")).data,
  });

  // Nobody can file leave until the desk declares a type (KEHOACH 9.5).
  const router = useRouter();
  const declares = role === "HR" || role === "ADMIN";
  const types = useQuery({
    queryKey: ["leave-types"],
    enabled: declares,
    queryFn: async () => (await api.get<{ id: string }[]>("/leave-types")).data,
  });

  const download = useMutation({
    mutationFn: async () => {
      const asked = onRequests ? { ...filter, state: url.state, ...order } : params;
      saveCsv((await api.get<string>(`${EXPORTS[tab].path}${queryOf(asked)}`)).data, EXPORTS[tab].file);
    },
    onSuccess: () => notify.done(t("exported")),
    onError: notify.failed,
  });

  const listed = rows.data?.pages.flatMap((one) => one.rows);
  const first = rows.data?.pages[0];
  const filtered = Object.values(filter).some((one) => one !== "") || url.state !== "";

  const LABEL: Record<Tab, string> = {
    requests: t("queueRequests"),
    disputes: t("queueDisputes"),
    certificates: t("queueCertificates"),
    profileChanges: t("queueProfile"),
    dependents: t("queueDependents"),
    advances: t("registerAdvances"),
  };
  const states: Record<string, string> = {
    "": t("anyState"),
    ...(tab === "requests" ? Object.fromEntries(STATES.map((one) => [one, t(`count${one}`)])) : {}),
    ...(tab === "certificates" ? Object.fromEntries(LETTER_STATES.map((one) => [one, c(one)])) : {}),
    ...(tab === "profileChanges" ? Object.fromEntries(CHANGE_STATES.map((one) => [one, p(`state${one}`)])) : {}),
    ...(tab === "disputes" ? Object.fromEntries(CLAIM_STATES.map((one) => [one, d(`state${one}`)])) : {}),
    ...(tab === "dependents" ? Object.fromEntries(DEPENDENT_STATES.map((one) => [one, me(`dependentState${one}`)])) : {}),
    ...(tab === "advances" ? Object.fromEntries(ADVANCE_STATES.map((one) => [one, pay(`advance${one}`)])) : {}),
  };
  const kinds: Record<string, string> | null =
    tab === "requests"
      ? { "": t("anyKind"), ...Object.fromEntries(REQUEST_KINDS.map((one: RequestKind) => [one, t(`kind${one}`)])) }
      : tab === "certificates"
        ? { "": t("anyKind"), ...Object.fromEntries(LETTER_KINDS.map((one) => [one, c(one)])) }
        : tab === "profileChanges"
          ? { "": t("anyKind"), ...Object.fromEntries(PROFILE_FIELDS.map((one) => [one, p(`field${one}`)])) }
          : null;

  const filters: Filter[] = [
    ...(kinds ? [{ key: "kind", label: t("kind"), value: url.kind, onChange: (next: string) => setUrl({ kind: next }), items: kinds }] : []),
    {
      key: "state",
      label: t("state"),
      value: url.state,
      onChange: (next) => setUrl({ state: next }),
      items: states,
      counts: onRequests ? counts.data : undefined,
    },
    {
      key: "dept",
      label: t("department"),
      value: url.dept,
      searchable: true,
      onChange: (next) => setUrl({ dept: next }),
      items: { "": t("anyDepartment"), ...Object.fromEntries((departments.data ?? []).map((one) => [one.id, one.name])) },
    },
  ];

  const params = {
    search: url.q,
    departmentId: url.dept,
    from: url.from,
    to: url.to,
    order: url.order || "desc",
    ...(url.state ? { state: url.state } : {}),
    ...(tab === "certificates" && url.kind ? { kind: url.kind } : {}),
    ...(tab === "profileChanges" && url.kind ? { field: url.kind } : {}),
  };

  const ledgerOrder: LedgerOrder = {
    dir: url.order === "asc" ? "asc" : "desc",
    onDir: (dir) => setUrl({ order: dir === "desc" ? "" : "asc" }),
  };
  const closing = useLedgerColumns<RequestRow>(
    (row) => row.createdAt,
    (row) => <StatePill state={row.state} />,
    (row) => ({ name: row.decidedBy?.fullName ?? row.decidedBy?.email, at: row.decidedAt }),
  );
  const columns: Column<RequestRow>[] = [
    ...personColumns<RequestRow>(t("who"), t("department"), common("empty")),
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
    ...closing,
  ];

  return (
    <>
      <PageHeader
        title={t("registerTitle")}
        description={t("deskLead")}
        tabs={shown.length > 1 ? shown.map((one) => ({ value: one.tab, label: LABEL[one.tab] })) : undefined}
        tab={tab}
        onTab={(next) => setUrl({ tab: next === "requests" ? "" : next, kind: "", state: "", sort: "", dir: "", order: "" })}
      />

      <PageLayout>
        {onRequests && declares && types.data?.length === 0 ? (
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
          search={{ value: typed, onChange: setTyped, placeholder: onRequests ? t("registerSearch") : t("inboxSearch") }}
          filters={filters}
          range={{ from: url.from, to: url.to, onFrom: (next) => setUrl({ from: next }), onTo: (next) => setUrl({ to: next }) }}
          extra={
            <Button variant="secondary" icon={DownloadSimpleIcon} loading={download.isPending} onClick={() => download.mutate()}>
              {common("export")}
            </Button>
          }
        />
        {onRequests ? (
          <DataTable
            id="requests"
            cardLead="person"
            cardTrailing="state"
            columns={columns}
            rows={listed}
            keyOf={(row) => row.id}
            pending={rows.isPending}
            failed={rows.isError}
            onRetry={() => void rows.refetch()}
            onRowClick={setOpen}
            sort={{ key: order.sort, dir: order.order === "asc" ? "asc" : "desc" }}
            onSortChange={(next) => setUrl({ sort: next.key === "createdAt" ? "" : next.key, dir: next.dir === "desc" ? "" : next.dir })}
            empty={filtered ? t("registerNoMatch") : t("registerEmpty")}
            emptyHint={filtered ? t("registerNoMatchHint") : undefined}
            paging={
              first
                ? {
                    shown: listed?.length ?? 0,
                    total: first.total,
                    exact: first.totalIsExact !== false,
                    onMore: rows.hasNextPage ? () => void rows.fetchNextPage() : undefined,
                    loading: rows.isFetchingNextPage,
                  }
                : undefined
            }
          />
        ) : null}
        {tab === "disputes" ? <DisputesQueue ledger order={ledgerOrder} params={params} filtered={filtered} {...NO_LINK} /> : null}
        {tab === "certificates" ? <LettersQueue ledger order={ledgerOrder} params={params} filtered={filtered} {...NO_LINK} /> : null}
        {tab === "profileChanges" ? <ChangesQueue ledger order={ledgerOrder} params={params} filtered={filtered} {...NO_LINK} /> : null}
        {tab === "dependents" ? <DependentsQueue ledger order={ledgerOrder} params={params} filtered={filtered} {...NO_LINK} /> : null}
        {tab === "advances" ? (
          <AdvancesQueue ledger order={ledgerOrder} paying={false} params={params} filtered={filtered} {...NO_LINK} />
        ) : null}
      </PageLayout>
      <RequestLedgerSheet row={open} onClose={() => setOpen(null)} />
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
