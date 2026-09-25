"use client";

import { Banner, Button, Input, LayerDialog, Select } from "@cloudflare/kumo";
import {
  ArrowUDownLeftIcon,
  ArrowUpRightIcon,
  ClockCounterClockwiseIcon,
  DownloadSimpleIcon,
  PencilSimpleIcon,
  PlusIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { Suspense, useEffect, useState } from "react";

import { AssetHistory, CONDITIONS, type Asset, type Condition } from "@/components/employees/assets";
import { DataTable, PersonCell, type Column } from "@/components/tables/data-table";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { useNotify } from "@/components/ui/notify";
import { useOptional } from "@/components/ui/optional";
import { PageHeader, PageLayout } from "@/components/ui/page";
import { PersonPicker, type Person } from "@/components/ui/person-picker";
import { StatePill, type Tone } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";
import { dayOnly } from "@/lib/format";
import { useUrlState } from "@/lib/url-state";

const STATES = ["IN_STOCK", "ISSUED", "RETURNED", "RETIRED", "LOST"] as const;
const TONE: Record<State, Tone> = { IN_STOCK: "good", ISSUED: "waiting", RETURNED: "idle", RETIRED: "idle", LOST: "bad" };
const kCodeMax = 32;
const kNameMax = 160;
const kKindMax = 32;
const kSerialMax = 64;
const kNoteMax = 500;
type State = (typeof STATES)[number];

interface RegisterRow extends Asset {
  note: string | null;
  issuedAt: string | null;
  holder?: { id: number; code: string; fullName: string; department?: { id: string; name: string } | null } | null;
}

interface AssetPage {
  rows: RegisterRow[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
}

interface Counts {
  states: Record<State, number>;
  kinds: string[];
}

interface Draft {
  held: RegisterRow | null;
  code: string;
  name: string;
  kind: string;
  serialNo: string;
  note: string;
}

function query(params: Record<string, string>): string {
  const kept = Object.entries(params).filter(([, value]) => value !== "");
  return kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
}

function save(text: string, name: string): void {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

export default function AssetsPage() {
  return (
    <Suspense>
      <Assets />
    </Suspense>
  );
}

function Assets() {
  const t = useTranslations("assets");
  const common = useTranslations("common");
  const format = useFormatter();
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();
  const optional = useOptional();

  const [url, setUrl] = useUrlState({ q: "", state: "", kind: "" });
  const [typed, setTyped] = useState(url.q);
  const settled = useSettled(typed.trim());
  useEffect(() => {
    if (settled !== url.q) {
      setUrl({ q: settled });
    }
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps

  const [draft, setDraft] = useState<Draft | null>(null);
  const [tried, setTried] = useState(false);
  const [showing, setShowing] = useState<Asset | null>(null);
  const [issuing, setIssuing] = useState<Asset | null>(null);
  const [taking, setTaking] = useState<Asset | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [person, setPerson] = useState<Person | null>(null);
  const [condition, setCondition] = useState<Condition>("GOOD");
  const [note, setNote] = useState("");

  const filters = { search: url.q, state: url.state, kind: url.kind };
  const register = useInfiniteQuery({
    queryKey: ["assets", "register", filters],
    initialPageParam: "",
    queryFn: async ({ pageParam }) => (await api.get<AssetPage>(`/assets${query({ ...filters, cursor: pageParam })}`)).data,
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const counts = useQuery({
    queryKey: ["assets", "counts", url.q, url.kind],
    queryFn: async () => (await api.get<Counts>(`/assets/counts${query({ search: url.q, kind: url.kind })}`)).data,
  });

  const add = useMutation({
    mutationFn: async (held: Draft) => {
      const body = {
        name: held.name.trim(),
        kind: held.kind.trim(),
      };
      if (held.held) {
        await api.patch(`/assets/${held.held.id}`, {
          ...body,
          serialNo: held.serialNo.trim() || null,
          note: held.note.trim() || null,
        });
        return held;
      }
      await api.post("/assets", { ...body, code: held.code.trim(), serialNo: held.serialNo.trim() || undefined });
      return held;
    },
    onSuccess: (held) => {
      setDraft(null);
      notify.done(held.held ? t("savedToast", { code: held.held.code }) : t("added", { code: held.code.trim() }));
      void cache.invalidateQueries({ queryKey: ["assets"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const exporting = useMutation({
    mutationFn: async () => save((await api.get<string>(`/assets/export${query(filters)}`)).data, "assets.csv"),
    onSuccess: () => notify.done(t("exported")),
    onError: notify.failed,
  });

  const handOver = useMutation({
    mutationFn: async (what: { asset: Asset; employeeId: number; issued: boolean }) => {
      await api.post(`/assets/${what.asset.id}/hand-over`, {
        employeeId: what.employeeId,
        issued: what.issued,
        condition,
        note: note || undefined,
      });
      return what;
    },
    onSuccess: (what) => {
      setIssuing(null);
      setTaking(null);
      notify.done(what.issued ? t("issuedToast", { name: what.asset.name }) : t("takenToast", { name: what.asset.name }));
      void cache.invalidateQueries({ queryKey: ["assets"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function openForm(one: RegisterRow | null): void {
    setFault(null);
    setTried(false);
    setDraft({
      held: one,
      code: one?.code ?? "",
      name: one?.name ?? "",
      kind: one?.kind ?? "",
      serialNo: one?.serialNo ?? "",
      note: one?.note ?? "",
    });
  }

  function submit(held: Draft): void {
    setTried(true);
    if (held.name.trim() === "" || held.kind.trim() === "" || (held.held === null && held.code.trim() === "")) {
      return;
    }
    setFault(null);
    add.mutate(held);
  }

  function openHandOver(asset: Asset): void {
    setFault(null);
    setTried(false);
    setCondition("GOOD");
    setNote("");
    setPerson(null);
    if (asset.state === "ISSUED") {
      setTaking(asset);
    } else {
      setIssuing(asset);
    }
  }

  const rows = register.data?.pages.flatMap((one) => one.rows);
  const first = register.data?.pages[0];
  const kinds = counts.data?.kinds ?? [];
  const stateCounts = counts.data
    ? { "": STATES.reduce((sum, one) => sum + counts.data.states[one], 0), ...counts.data.states }
    : undefined;
  const filtered = url.q !== "" || url.state !== "" || url.kind !== "";

  const columns: Column<RegisterRow>[] = [
    { id: "asset", header: t("asset"), cell: (row) => <PersonCell name={row.name} code={row.code} /> },
    {
      id: "state",
      header: t("state"),
      cell: (row) => <StatePill tone={TONE[row.state]}>{t(`state${row.state}`)}</StatePill>,
    },
    {
      id: "holder",
      header: t("holder"),
      cell: (row) =>
        row.holder ? (
          <PersonCell name={row.holder.fullName} code={row.holder.code} href={`/employees/${row.holder.id}?tab=assets`} />
        ) : (
          common("empty")
        ),
    },
    {
      id: "department",
      header: t("department"),
      priority: 3,
      truncate: true,
      cell: (row) => row.holder?.department?.name ?? common("empty"),
    },
    {
      id: "issuedAt",
      header: t("issuedAt"),
      priority: 2,
      cell: (row) =>
        row.issuedAt ? <span className="tabular-nums">{format.dateTime(dayOnly(row.issuedAt), "day")}</span> : common("empty"),
    },
    { id: "kind", header: t("kind"), priority: 3, truncate: true, cell: (row) => row.kind },
    {
      id: "serial",
      header: t("serial"),
      priority: 3,
      truncate: true,
      cell: (row) => (row.serialNo ? <span className="font-mono">{row.serialNo}</span> : common("empty")),
    },
  ];

  const faultBanner = fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} className="mt-4" /> : null;
  const conditionFields = (
    <>
      <Select
        label={t("condition")}
        hideLabel={false}
        value={condition}
        onValueChange={(next) => setCondition(String(next ?? "GOOD") as Condition)}
        items={Object.fromEntries(CONDITIONS.map((one) => [one, t(`condition${one}`)]))}
        className="w-full"
      />
      <Input label={optional(t("note"))} maxLength={kNoteMax} value={note} onChange={(event) => setNote(event.target.value)} />
    </>
  );

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("lead")}
        actions={
          <Button variant="primary" icon={PlusIcon} onClick={() => openForm(null)}>
            {t("add")}
          </Button>
        }
      />

      <PageLayout>
        <FilterBar
          search={{ value: typed, onChange: setTyped, placeholder: t("searchHint") }}
          filters={[
            {
              key: "state",
              label: t("state"),
              value: url.state,
              onChange: (next) => setUrl({ state: next }),
              items: { "": t("anyState"), ...Object.fromEntries(STATES.map((one) => [one, t(`state${one}`)])) },
              counts: stateCounts,
            },
            {
              key: "kind",
              label: t("kind"),
              value: url.kind,
              searchable: kinds.length > 8,
              onChange: (next) => setUrl({ kind: next }),
              items: { "": t("anyKind"), ...Object.fromEntries(kinds.map((one) => [one, one])) },
            },
          ]}
          extra={
            <Button variant="secondary" icon={DownloadSimpleIcon} loading={exporting.isPending} onClick={() => exporting.mutate()}>
              {common("export")}
            </Button>
          }
        />
        <DataTable
          id="assets"
          cardLead="asset"
          cardTrailing="state"
          columns={columns}
          rows={rows}
          keyOf={(row) => row.id}
          pending={register.isPending}
          failed={register.isError}
          onRetry={() => void register.refetch()}
          empty={filtered ? t("noMatch") : t("registerEmpty")}
          emptyHint={filtered ? t("noMatchHint") : t("registerEmptyHint")}
          emptyAction={
            filtered ? undefined : (
              <Button variant="secondary" icon={PlusIcon} onClick={() => openForm(null)}>
                {t("add")}
              </Button>
            )
          }
          onRowClick={setShowing}
          rowActions={(row) => [
            { key: "history", label: t("history"), icon: ClockCounterClockwiseIcon, onSelect: () => setShowing(row) },
            { key: "edit", label: t("edit"), icon: PencilSimpleIcon, onSelect: () => openForm(row) },
            ...(row.state === "IN_STOCK" || row.state === "RETURNED"
              ? [{ key: "issue", label: t("issueTo"), icon: ArrowUpRightIcon, onSelect: () => openHandOver(row) }]
              : []),
            ...(row.state === "ISSUED" ? [{ key: "take", label: t("take"), icon: ArrowUDownLeftIcon, onSelect: () => openHandOver(row) }] : []),
          ]}
          paging={
            first
              ? {
                  shown: rows?.length ?? 0,
                  total: first.total,
                  exact: first.totalIsExact,
                  onMore: register.hasNextPage ? () => void register.fetchNextPage() : undefined,
                  loading: register.isFetchingNextPage,
                }
              : undefined
          }
        />
      </PageLayout>

      <LayerDialog.Root open={draft !== null} onOpenChange={(next) => !next && setDraft(null)} dismissDisabled={add.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{draft?.held ? t("editTitle", { code: draft.held.code }) : t("add")}</LayerDialog.Title>
          {draft?.held ? <LayerDialog.Description>{t("editLead")}</LayerDialog.Description> : null}
          <LayerDialog.Body>
            {draft ? (
              <div className="grid items-start gap-4 sm:grid-cols-2">
                {draft.held === null ? (
                  <Input
                    label={t("code")}
                    required
                    maxLength={kCodeMax}
                    value={draft.code}
                    error={tried && draft.code.trim() === "" ? common("required") : undefined}
                    onChange={(event) => setDraft({ ...draft, code: event.target.value.toUpperCase() })}
                    className="font-mono"
                  />
                ) : null}
                <Input
                  label={t("name")}
                  required
                  maxLength={kNameMax}
                  value={draft.name}
                  error={tried && draft.name.trim() === "" ? common("required") : undefined}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
                <Input
                  label={t("kind")}
                  description={kinds.length > 0 ? t("kindHint", { kinds: kinds.slice(0, 4).join(", ") }) : undefined}
                  required
                  maxLength={kKindMax}
                  value={draft.kind}
                  error={tried && draft.kind.trim() === "" ? common("required") : undefined}
                  onChange={(event) => setDraft({ ...draft, kind: event.target.value })}
                />
                <Input
                  label={optional(t("serial"))}
                  maxLength={kSerialMax}
                  value={draft.serialNo}
                  onChange={(event) => setDraft({ ...draft, serialNo: event.target.value })}
                />
                {draft.held ? (
                  <div className="sm:col-span-2">
                    <Input
                      label={optional(t("note"))}
                      maxLength={kNoteMax}
                      value={draft.note}
                      onChange={(event) => setDraft({ ...draft, note: event.target.value })}
                    />
                  </div>
                ) : null}
                <div className="sm:col-span-2">{faultBanner}</div>
              </div>
            ) : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary loading={add.isPending} onClick={() => draft && submit(draft)}>
              {draft?.held ? common("save") : t("add")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Root
        open={issuing !== null}
        onOpenChange={(next) => {
          if (!next) {
            setIssuing(null);
          }
        }}
        dismissDisabled={handOver.isPending}
      >
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{issuing ? t("issueTitle", { name: issuing.name }) : t("issueTo")}</LayerDialog.Title>
          <LayerDialog.Description>{t("issueLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              <PersonPicker
                label={t("issueWho")}
                error={tried && person === null ? t("issueWhoMissing") : undefined}
                value={person}
                onChange={setPerson}
              />
              {conditionFields}
            </div>
            {faultBanner}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              loading={handOver.isPending}
              onClick={() => {
                setTried(true);
                if (issuing && person) {
                  setFault(null);
                  handOver.mutate({ asset: issuing, employeeId: person.id, issued: true });
                }
              }}
            >
              {t("issueAction")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Root
        open={taking !== null}
        onOpenChange={(next) => {
          if (!next) {
            setTaking(null);
          }
        }}
        dismissDisabled={handOver.isPending}
      >
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{taking ? t("takeTitle", { name: taking.name }) : t("take")}</LayerDialog.Title>
          <LayerDialog.Description>
            {taking?.holder ? t("takeFrom", { name: taking.holder.fullName }) : t("takeLead")}
          </LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">{conditionFields}</div>
            {faultBanner}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              loading={handOver.isPending}
              disabled={!taking?.holder}
              onClick={() => {
                if (taking?.holder) {
                  setFault(null);
                  handOver.mutate({ asset: taking, employeeId: taking.holder.id, issued: false });
                }
              }}
            >
              {t("take")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <AssetHistory asset={showing} onClose={() => setShowing(null)} />
    </>
  );
}
