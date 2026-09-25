"use client";

import { Banner, Button, Empty, Input, LayerCard, LayerDialog, SkeletonLine } from "@cloudflare/kumo";
import { FileTextIcon, PlusIcon, WarningCircleIcon, XCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Suspense, useState, type FormEvent } from "react";

import { RequestCard, type RequestKind, type RequestRow } from "@/components/requests/request-card";
import { isRequestKind, RequestForm, todayHere } from "@/components/requests/request-form";
import { DataTable, type Column } from "@/components/tables/data-table";
import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { CountPill, StatePill, type Tone } from "@/components/ui/pill";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { dayOnly, days, money } from "@/lib/format";
import { useOutbox } from "@/lib/outbox";

type AdvanceState = "PENDING" | "APPROVED" | "REJECTED" | "PAID" | "SETTLED" | "CANCELLED";

interface Advance {
  id: string;
  amount: string;
  reason: string;
  state: AdvanceState;
  requestedAt: string;
  decisionNote: string | null;
  employee?: { id: number };
}

interface Balance {
  leaveTypeId: string;
  name: string;
  remaining: number;
  bookedAfter: number;
}

type Tab = "requests" | "advances";

const kHere = "/me/requests";
const kAdvanceForm = "advance-form";

const ADVANCE_TONE: Record<AdvanceState, Tone> = {
  PENDING: "waiting",
  APPROVED: "good",
  PAID: "good",
  SETTLED: "idle",
  REJECTED: "bad",
  CANCELLED: "idle",
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function MyRequests() {
  const t = useTranslations("requests");
  const pay = useTranslations("payroll");
  const me = useTranslations("me");
  const common = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();
  const faultOf = useFault();
  const notify = useNotify();
  const cache = useQueryClient();
  const router = useRouter();
  const search = useSearchParams();
  const employeeId = useSession((s) => s.employeeId);
  const waiting = useOutbox();

  const tab: Tab = search.get("tab") === "advances" ? "advances" : "requests";
  const askedKind = search.get("new");
  const askedDate = search.get("date");
  const linked = isRequestKind(askedKind)
    ? { kind: askedKind, date: askedDate && DAY.test(askedDate) ? askedDate : undefined }
    : null;

  const [seed, setSeed] = useState(0);
  const [filing, setFiling] = useState(false);
  const [dropping, setDropping] = useState<RequestRow | null>(null);
  const [asking, setAsking] = useState(false);
  const [amount, setAmount] = useState("");
  const [why, setWhy] = useState("");
  const [advanceFault, setAdvanceFault] = useState<string | null>(null);
  const [droppingAdvance, setDroppingAdvance] = useState<Advance | null>(null);

  const mine = useQuery({
    queryKey: ["requests", "mine", employeeId],
    enabled: employeeId !== null,
    queryFn: async () =>
      (await api.get<{ rows: RequestRow[]; total: number }>(`/requests?employeeId=${employeeId}`)).data,
  });

  // A desk role reads everybody's advances here, so the query names the viewer.
  const advances = useQuery({
    queryKey: ["advances", "mine", employeeId],
    enabled: employeeId !== null,
    queryFn: async () => (await api.get<{ rows: Advance[] }>(`/advances?employeeId=${employeeId}`)).data.rows,
  });

  const balances = useQuery({
    queryKey: ["leave-balances", todayHere()],
    enabled: employeeId !== null,
    queryFn: async () => (await api.get<Balance[]>(`/leave-balances?asOf=${todayHere()}`)).data,
  });

  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/requests/${id}/cancel`, {}),
    onSuccess: () => {
      notify.done(t("withdrawn"));
      setDropping(null);
      void cache.invalidateQueries({ queryKey: ["requests"] });
      void cache.invalidateQueries({ queryKey: ["leave-balances"] });
    },
    onError: (fell: unknown) => {
      notify.failed(fell);
      setDropping(null);
    },
  });

  const ask = useMutation({
    mutationFn: () => api.post("/advances", { amount: Number(amount), reason: why }),
    onSuccess: () => {
      notify.done(pay("advanceAsked"));
      setAsking(false);
      void cache.invalidateQueries({ queryKey: ["advances"] });
    },
    onError: (fell: unknown) => setAdvanceFault(faultOf(fell)),
  });

  const drop = useMutation({
    mutationFn: (id: string) => api.post(`/advances/${id}/cancel`, {}),
    onSuccess: () => {
      notify.done(pay("advanceDropped"));
      setDroppingAdvance(null);
      void cache.invalidateQueries({ queryKey: ["advances"] });
    },
    onError: (fell: unknown) => {
      notify.failed(fell);
      setDroppingAdvance(null);
    },
  });

  function openForm(): void {
    setSeed((held) => held + 1);
    setFiling(true);
  }

  function closeForm(): void {
    setFiling(false);
    if (linked) {
      router.replace(kHere, { scroll: false });
    }
  }

  function openAdvance(): void {
    setAmount("");
    setWhy("");
    setAdvanceFault(null);
    ask.reset();
    setAsking(true);
  }

  function spanOf(row: { fromDate: string; toDate: string }): string {
    const from = format.dateTime(dayOnly(row.fromDate), "day");
    return row.fromDate === row.toDate ? from : `${from} → ${format.dateTime(dayOnly(row.toDate), "day")}`;
  }

  function kindName(kind: RequestKind): string {
    return t(`kind${kind}`);
  }

  const advanceColumns: Column<Advance>[] = [
    {
      id: "amount",
      header: pay("advanceAmount"),
      numeric: true,
      sortBy: (row) => Number(row.amount),
      cell: (row) => money(Number(row.amount), locale),
    },
    {
      id: "reason",
      header: t("reason"),
      cell: (row) => (
        <span className="flex flex-col">
          <span className="line-clamp-2">{row.reason}</span>
          {row.decisionNote ? <span className="text-kumo-subtle">{row.decisionNote}</span> : null}
        </span>
      ),
    },
    {
      id: "requestedAt",
      header: pay("advanceAt"),
      sortBy: (row) => row.requestedAt,
      cell: (row) => <span className="tabular-nums">{format.dateTime(new Date(row.requestedAt), "day")}</span>,
    },
    {
      id: "state",
      header: t("state"),
      cell: (row) => <StatePill tone={ADVANCE_TONE[row.state]}>{pay(`advance${row.state}`)}</StatePill>,
    },
  ];

  const formOpen = filing || linked !== null;
  const rows = mine.data?.rows ?? [];

  return (
    <>
      <PageHeader
        title={t("mineTitle")}
        description={t("mineLead")}
        actions={
          tab === "requests" ? (
            <Button variant="primary" icon={PlusIcon} onClick={openForm}>
              {t("new")}
            </Button>
          ) : (
            <Button variant="primary" icon={PlusIcon} onClick={openAdvance}>
              {pay("advanceNew")}
            </Button>
          )
        }
        tabs={[
          { value: "requests", label: t("tabRequests") },
          { value: "advances", label: pay("advances") },
        ]}
        tab={tab}
        onTab={(next) => router.replace(next === "advances" ? `${kHere}?tab=advances` : kHere, { scroll: false })}
      />

      <PageLayout
        aside={
          tab === "advances" ? undefined : (
            <>
              {waiting.length > 0 ? (
                <AsideCard title={t("outboxTitle")} action={<CountPill>{waiting.length}</CountPill>}>
                  <p className="text-kumo-subtle">{t("waitingToSend", { count: waiting.length })}</p>
                  <ul className="mt-3 flex flex-col">
                    {waiting.map((one) => {
                      const kind = String(one.body.kind ?? "");
                      return (
                        <li key={one.clientKey} className="flex items-center justify-between gap-3 border-b border-kumo-hairline py-2 last:border-0">
                          <span className="min-w-0 truncate">{isRequestKind(kind) ? kindName(kind) : kind}</span>
                          <span className="shrink-0 text-kumo-subtle tabular-nums">
                            {spanOf({ fromDate: String(one.body.fromDate ?? ""), toDate: String(one.body.toDate ?? "") })}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </AsideCard>
              ) : null}
              <AsideCard title={me("leaveLeft")}>
                {balances.isPending ? (
                  <div className="flex flex-col gap-2">
                    <SkeletonLine minWidth={120} maxWidth={240} />
                    <SkeletonLine minWidth={120} maxWidth={240} />
                  </div>
                ) : balances.isError ? (
                  <Failed onRetry={() => void balances.refetch()} />
                ) : (balances.data ?? []).length === 0 ? (
                  <p className="text-kumo-subtle">{t("balancesEmpty")}</p>
                ) : (
                  <Facts
                    rows={(balances.data ?? []).map((one) => [
                      one.name,
                      <span key={one.leaveTypeId} className="font-medium tabular-nums">
                        {days(one.remaining, locale)}
                      </span>,
                    ])}
                  />
                )}
              </AsideCard>
            </>
          )
        }
      >
        {tab === "requests" ? (
          mine.isError ? (
            <Failed onRetry={() => void mine.refetch()} />
          ) : mine.isPending ? (
            <LayerCard className="flex flex-col gap-3 p-4">
              {Array.from({ length: 3 }, (_, at) => (
                <SkeletonLine key={at} minWidth={160} maxWidth={320} />
              ))}
            </LayerCard>
          ) : rows.length === 0 ? (
            <LayerCard className="p-0">
              <Empty
                icon={<FileTextIcon size={40} className="text-kumo-inactive" />}
                title={t("mineEmpty")}
                description={t("mineEmptyHint")}
                contents={
                  <Button variant="primary" icon={PlusIcon} onClick={openForm}>
                    {t("new")}
                  </Button>
                }
                className="py-12"
              />
            </LayerCard>
          ) : (
            <div className="flex flex-col gap-3">
              {rows.map((row) => (
                <RequestCard
                  key={row.id}
                  row={row}
                  titleBy="kind"
                  busy={cancel.isPending && cancel.variables === row.id}
                  onCancel={() => setDropping(row)}
                />
              ))}
            </div>
          )
        ) : (
          <DataTable
            id="my-advances"
            cardLead="amount"
            columns={advanceColumns}
            rows={advances.data}
            keyOf={(row) => row.id}
            pending={advances.isPending}
            failed={advances.isError}
            onRetry={() => void advances.refetch()}
            empty={pay("advanceEmpty")}
            emptyHint={pay("advanceEmptyHint")}
            emptyAction={
              <Button variant="primary" icon={PlusIcon} onClick={openAdvance}>
                {pay("advanceNew")}
              </Button>
            }
            rowActions={(row) =>
              row.state === "PENDING"
                ? [{ key: "drop", label: t("cancel"), icon: XCircleIcon, danger: true, onSelect: () => setDroppingAdvance(row) }]
                : []
            }
          />
        )}
      </PageLayout>

      <RequestForm
        key={linked ? `link-${linked.kind}-${linked.date ?? ""}` : `form-${seed}`}
        open={formOpen}
        onOpenChange={(next) => (next ? setFiling(true) : closeForm())}
        kind={linked?.kind}
        date={linked?.date}
      />

      <LayerDialog.Alert open={dropping !== null} onOpenChange={(next) => !next && setDropping(null)} dismissDisabled={cancel.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("withdrawTitle")}</LayerDialog.Title>
          <LayerDialog.Description>
            {dropping ? t("withdrawLead", { kind: kindName(dropping.kind), span: spanOf(dropping) }) : ""}
          </LayerDialog.Description>
          <LayerDialog.Body>
            {dropping ? <p className="line-clamp-3 text-kumo-subtle">{dropping.reason}</p> : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("back")}>
            <LayerDialog.Actions.Primary
              variant="destructive"
              loading={cancel.isPending}
              onClick={() => dropping && cancel.mutate(dropping.id)}
            >
              {t("cancel")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>

      <LayerDialog.Root open={asking} onOpenChange={setAsking} dismissDisabled={ask.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{pay("advanceNew")}</LayerDialog.Title>
          <LayerDialog.Description>{pay("advanceLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <form
              id={kAdvanceForm}
              className="flex flex-col gap-4"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                setAdvanceFault(null);
                ask.mutate();
              }}
            >
              <Input
                label={pay("advanceAmount")}
                type="number"
                inputMode="numeric"
                min={1}
                step={1000}
                required
                value={amount}
                description={Number(amount) > 0 ? money(Number(amount), locale) : pay("advanceAmountHint")}
                onChange={(event) => setAmount(event.target.value)}
              />
              <Input label={t("reason")} required maxLength={500} value={why} onChange={(event) => setWhy(event.target.value)} />
              {advanceFault ? (
                <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title={advanceFault} />
              ) : null}
            </form>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary type="submit" form={kAdvanceForm} loading={ask.isPending}>
              {pay("advanceNew")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Alert
        open={droppingAdvance !== null}
        onOpenChange={(next) => !next && setDroppingAdvance(null)}
        dismissDisabled={drop.isPending}
      >
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{pay("advanceDropTitle")}</LayerDialog.Title>
          <LayerDialog.Description>
            {droppingAdvance ? pay("advanceDropLead", { amount: money(Number(droppingAdvance.amount), locale) }) : ""}
          </LayerDialog.Description>
          <LayerDialog.Body>
            {droppingAdvance ? <p className="line-clamp-3 text-kumo-subtle">{droppingAdvance.reason}</p> : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("back")}>
            <LayerDialog.Actions.Primary
              variant="destructive"
              loading={drop.isPending}
              onClick={() => droppingAdvance && drop.mutate(droppingAdvance.id)}
            >
              {t("cancel")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </>
  );
}

// The prefilled form rides on the query string, which the prerender does not have.
export default function MyRequestsPage() {
  return (
    <Suspense>
      <MyRequests />
    </Suspense>
  );
}
