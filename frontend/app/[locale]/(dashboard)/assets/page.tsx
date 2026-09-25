"use client";

import { Banner, Button, Input, LayerDialog, Select } from "@cloudflare/kumo";
import {
  ArrowUDownLeftIcon,
  ArrowUpRightIcon,
  ClockCounterClockwiseIcon,
  PlusIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { AssetHistory, CONDITIONS, type Asset, type Condition } from "@/components/employees/assets";
import { DataTable, type Column } from "@/components/tables/data-table";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, PageHeader, PageLayout, StatList } from "@/components/ui/page";
import { PersonPicker, type Person } from "@/components/ui/person-picker";
import { StatePill, type Tone } from "@/components/ui/pill";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";

const STATES = ["IN_STOCK", "ISSUED", "RETURNED", "RETIRED", "LOST"] as const;
const TONE: Record<State, Tone> = { IN_STOCK: "good", ISSUED: "waiting", RETURNED: "idle", RETIRED: "idle", LOST: "bad" };
type State = (typeof STATES)[number];

interface AssetPage {
  rows: Asset[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
}

interface Counts {
  states: Record<State, number>;
  kinds: string[];
}

function query(params: Record<string, string>): string {
  const kept = Object.entries(params).filter(([, value]) => value !== "");
  return kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
}

export default function AssetsPage() {
  const t = useTranslations("assets");
  const common = useTranslations("common");
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();

  const [state, setState] = useState<State | "">("");
  const [kindFilter, setKindFilter] = useState("");
  const [typed, setTyped] = useState("");
  const search = useSettled(typed.trim());

  const [adding, setAdding] = useState(false);
  const [showing, setShowing] = useState<Asset | null>(null);
  const [issuing, setIssuing] = useState<Asset | null>(null);
  const [taking, setTaking] = useState<Asset | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("");
  const [serialNo, setSerialNo] = useState("");
  const [person, setPerson] = useState<Person | null>(null);
  const [condition, setCondition] = useState<Condition>("GOOD");
  const [note, setNote] = useState("");

  const register = useInfiniteQuery({
    queryKey: ["assets", "register", { state, kindFilter, search }],
    initialPageParam: "",
    queryFn: async ({ pageParam }) =>
      (await api.get<AssetPage>(`/assets${query({ state, kind: kindFilter, search, cursor: pageParam })}`)).data,
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const counts = useQuery({
    queryKey: ["assets", "counts"],
    queryFn: async () => (await api.get<Counts>("/assets/counts")).data,
  });

  const add = useMutation({
    mutationFn: () =>
      api.post("/assets", { code: code.trim(), name: name.trim(), kind: kind.trim(), serialNo: serialNo.trim() || undefined }),
    onSuccess: () => {
      setAdding(false);
      notify.done(t("added", { code: code.trim() }));
      void cache.invalidateQueries({ queryKey: ["assets"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
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

  function openAdd(): void {
    setFault(null);
    setCode("");
    setName("");
    setKind("");
    setSerialNo("");
    setAdding(true);
  }

  function openHandOver(asset: Asset): void {
    setFault(null);
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
  const tally = (one: State) => counts.data?.states[one] ?? common("empty");
  const total = counts.data ? STATES.reduce((sum, one) => sum + counts.data.states[one], 0) : null;
  const lost = counts.data?.states.LOST ?? 0;
  const filtered = state !== "" || kindFilter !== "" || search !== "";

  const columns: Column<Asset>[] = [
    {
      id: "asset",
      header: t("asset"),
      sticky: true,
      sortBy: (row) => row.code,
      cell: (row) => (
        <span className="flex flex-col">
          <span>{row.name}</span>
          <span className="font-mono text-sm text-kumo-subtle">{row.code}</span>
        </span>
      ),
    },
    {
      id: "state",
      header: t("state"),
      sortBy: (row) => row.state,
      cell: (row) => <StatePill tone={TONE[row.state]}>{t(`state${row.state}`)}</StatePill>,
    },
    {
      id: "holder",
      header: t("holder"),
      sortBy: (row) => row.holder?.fullName ?? "",
      cell: (row) =>
        row.holder ? (
          <Link href={`/employees/${row.holder.id}?tab=assets`} className="text-kumo-link hover:underline">
            {row.holder.fullName}
          </Link>
        ) : (
          common("empty")
        ),
    },
    { id: "kind", header: t("kind"), sortBy: (row) => row.kind, cell: (row) => <span className="whitespace-nowrap">{row.kind}</span> },
    {
      id: "serial",
      header: t("serial"),
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
      <Input label={t("note")} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
    </>
  );

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("lead")}
        actions={
          <Button variant="primary" icon={PlusIcon} onClick={openAdd}>
            {t("add")}
          </Button>
        }
      />

      <PageLayout
        aside={
          <AsideCard title={t("summaryTitle")}>
            <StatList
              stats={[
                ...STATES.map((one) => ({
                  key: one,
                  label: t(`state${one}`),
                  value: tally(one),
                  tone: one === "LOST" && lost > 0 ? ("danger" as const) : undefined,
                  active: state === one,
                  onPick: () => setState(one),
                })),
                {
                  key: "all",
                  label: common("all"),
                  value: total ?? common("empty"),
                  active: state === "",
                  onPick: () => setState(""),
                },
              ]}
            />
          </AsideCard>
        }
      >
        <FilterBar
          search={{ value: typed, onChange: setTyped, placeholder: t("searchHint") }}
          filters={[
            {
              key: "state",
              label: t("state"),
              value: state,
              onChange: (next) => setState(next as State | ""),
              items: { "": t("anyState"), ...Object.fromEntries(STATES.map((one) => [one, t(`state${one}`)])) },
            },
            {
              key: "kind",
              label: t("kind"),
              value: kindFilter,
              onChange: setKindFilter,
              items: { "": t("anyKind"), ...Object.fromEntries(kinds.map((one) => [one, one])) },
            },
          ]}
        />
        <DataTable
          id="assets"
          cardLead="asset"
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
              <Button variant="secondary" icon={PlusIcon} onClick={openAdd}>
                {t("add")}
              </Button>
            )
          }
          onRowClick={setShowing}
          rowActions={(row) => [
            { key: "history", label: t("history"), icon: ClockCounterClockwiseIcon, onSelect: () => setShowing(row) },
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

      <LayerDialog.Root open={adding} onOpenChange={setAdding} dismissDisabled={add.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("add")}</LayerDialog.Title>
          <LayerDialog.Body>
            <form
              id="asset-add"
              className="grid items-start gap-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                setFault(null);
                add.mutate();
              }}
            >
              <Input
                label={t("code")}
                required
                maxLength={32}
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                className="font-mono"
              />
              <Input label={t("name")} required maxLength={160} value={name} onChange={(event) => setName(event.target.value)} />
              <Input
                label={t("kind")}
                description={kinds.length > 0 ? t("kindHint", { kinds: kinds.slice(0, 4).join(", ") }) : undefined}
                required
                maxLength={32}
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              />
              <Input label={t("serial")} maxLength={64} value={serialNo} onChange={(event) => setSerialNo(event.target.value)} />
            </form>
            {faultBanner}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary type="submit" form="asset-add" loading={add.isPending}>
              {t("add")}
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
              <PersonPicker label={t("issueWho")} value={person} onChange={setPerson} />
              {conditionFields}
            </div>
            {faultBanner}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              loading={handOver.isPending}
              disabled={person === null}
              onClick={() => {
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
