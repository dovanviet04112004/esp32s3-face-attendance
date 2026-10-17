"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Suspense, useEffect, useMemo, useState } from "react";

import { QUEUE_ROLES, useInboxCounts, type Queue } from "@/components/nav/waiting-count";
import { type RequestKind } from "@/components/requests/request-card";
import { REQUEST_KINDS } from "@/components/requests/request-form";
import {
  AdvancesQueue,
  ChangesQueue,
  DependentsQueue,
  DisputesQueue,
  LETTER_KINDS,
  LettersQueue,
  PROFILE_FIELDS,
  PunchesQueue,
  QUEUE_ORDER,
  RequestsQueue,
  type Linked,
} from "@/components/requests/queues";
import { FilterBar, useSettled, type Filter } from "@/components/ui/filter-bar";
import { PageHeader, PageLayout } from "@/components/ui/page";
import { CountPill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useUrlState } from "@/lib/url-state";

const DEFAULTS = { tab: "", q: "", kind: "", dept: "", from: "", to: "", order: "", open: "" };

type UrlState = typeof DEFAULTS;

interface Department {
  id: string;
  name: string;
}

function Inbox() {
  const t = useTranslations("requests");
  const c = useTranslations("certificates");
  const p = useTranslations("profile");
  const role = useSession((s) => s.role);
  const counts = useInboxCounts(role);
  const [url, setUrl] = useUrlState<UrlState>(DEFAULTS);
  const [typed, setTyped] = useState(url.q);
  const settled = useSettled(typed.trim());

  useEffect(() => {
    if (settled !== url.q) {
      setUrl({ q: settled });
    }
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Department[]>("/departments")).data,
  });

  const LABEL: Record<Queue, string> = {
    requests: t("queueRequests"),
    disputes: t("queueDisputes"),
    certificates: t("queueCertificates"),
    profileChanges: t("queueProfile"),
    dependents: t("queueDependents"),
    advancesToDecide: t("queueAdvances"),
    advancesToPay: t("queueToPay"),
    punches: t("queuePunches"),
  };
  const visible = QUEUE_ORDER.filter((one) => role !== null && QUEUE_ROLES[one].includes(role));
  const busiest = visible.find((one) => (counts.data?.[one] ?? 0) > 0) ?? visible[0];
  const tab = (visible as string[]).includes(url.tab) ? (url.tab as Queue) : busiest;
  const waiting = counts.data ? visible.reduce((total, one) => total + counts.data[one], 0) : undefined;
  // An empty queue has nothing to decide, so its tab only stays while it is the one open.
  const shown = counts.data ? visible.filter((one) => one === tab || counts.data[one] > 0) : visible;

  const params = useMemo(
    () => ({
      search: url.q,
      departmentId: url.dept,
      from: url.from,
      to: url.to,
      order: url.order || "asc",
      ...(tab === "requests" && url.kind ? { kind: url.kind } : {}),
      ...(tab === "certificates" && url.kind ? { kind: url.kind } : {}),
      ...(tab === "profileChanges" && url.kind ? { field: url.kind } : {}),
    }),
    [url.q, url.dept, url.from, url.to, url.order, url.kind, tab],
  );
  const filtered = url.q !== "" || url.dept !== "" || url.from !== "" || url.to !== "" || url.kind !== "";
  const link: Linked = { openId: url.open, onOpened: () => setUrl({ open: "" }) };

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
      key: "dept",
      label: t("department"),
      value: url.dept,
      searchable: true,
      onChange: (next) => setUrl({ dept: next }),
      items: { "": t("anyDepartment"), ...Object.fromEntries((departments.data ?? []).map((one) => [one.id, one.name])) },
    },
    {
      key: "order",
      label: t("order"),
      value: url.order,
      onChange: (next) => setUrl({ order: next }),
      items: { "": t("orderOldest"), desc: t("orderNewest") },
    },
  ];

  return (
    <>
      <PageHeader
        title={t("approvalsTitle")}
        description={t("approvalsLead")}
        meta={waiting ? <CountPill>{waiting}</CountPill> : undefined}
        tabs={shown.map((one) => ({
          value: one,
          label: (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              {LABEL[one]}
              {counts.data ? <CountPill>{counts.data[one]}</CountPill> : null}
            </span>
          ),
        }))}
        tab={tab}
        onTab={(next) => setUrl({ tab: next, kind: "" })}
      />

      <PageLayout>
        <FilterBar
          search={{ value: typed, onChange: setTyped, placeholder: t("inboxSearch") }}
          filters={filters}
          range={{ from: url.from, to: url.to, onFrom: (next) => setUrl({ from: next }), onTo: (next) => setUrl({ to: next }) }}
        />
        {tab === "requests" ? <RequestsQueue params={params} filtered={filtered} {...link} /> : null}
        {tab === "certificates" ? <LettersQueue params={params} filtered={filtered} {...link} /> : null}
        {tab === "profileChanges" ? <ChangesQueue params={params} filtered={filtered} {...link} /> : null}
        {tab === "disputes" ? <DisputesQueue params={params} filtered={filtered} {...link} /> : null}
        {tab === "advancesToDecide" ? <AdvancesQueue params={params} filtered={filtered} paying={false} {...link} /> : null}
        {tab === "advancesToPay" ? <AdvancesQueue params={params} filtered={filtered} paying {...link} /> : null}
        {tab === "dependents" ? <DependentsQueue params={params} filtered={filtered} {...link} /> : null}
        {tab === "punches" ? <PunchesQueue params={params} filtered={filtered} {...link} /> : null}
      </PageLayout>
    </>
  );
}

// The tab and the filters ride on the query string, which the prerender does not have.
export default function ApprovalsPage() {
  return (
    <Suspense>
      <Inbox />
    </Suspense>
  );
}
