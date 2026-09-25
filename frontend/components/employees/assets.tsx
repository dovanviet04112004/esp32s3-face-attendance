"use client";

import { Banner, Button, Empty, Input, LayerDialog, LinkButton, Select, SkeletonLine } from "@cloudflare/kumo";
import {
  ArrowUDownLeftIcon,
  ClockCounterClockwiseIcon,
  PackageIcon,
  PlusIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { StatePill } from "@/components/ui/pill";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";

export const CONDITIONS = ["NEW", "GOOD", "WORN", "DAMAGED"] as const;
// The largest page the register serves; a shelf that long is searched, not scrolled.
const kShelf = 200;

export type Condition = (typeof CONDITIONS)[number];

export interface Asset {
  id: string;
  code: string;
  name: string;
  kind: string;
  serialNo?: string | null;
  state: "IN_STOCK" | "ISSUED" | "RETURNED" | "RETIRED" | "LOST";
  holder?: { id: number; code: string; fullName: string } | null;
}

interface Transfer {
  id: string;
  issued: boolean;
  at: string;
  condition: Condition | null;
  note: string | null;
  employeeId: number;
  employee?: { id: number; code: string; fullName: string } | null;
}

/** Every hand-over one asset has been through, newest first, in a dialog. */
export function AssetHistory({ asset, onClose }: { asset: Asset | null; onClose: () => void }) {
  const t = useTranslations("assets");
  const common = useTranslations("common");
  const format = useFormatter();

  const history = useQuery({
    queryKey: ["assets", "history", asset?.id],
    enabled: asset !== null,
    queryFn: async () => (await api.get<Transfer[]>(`/assets/${asset?.id}/history`)).data,
  });

  return (
    <LayerDialog.Root
      open={asset !== null}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <LayerDialog.Content closeLabel={common("close")}>
        <LayerDialog.Title>{asset ? t("historyOf", { name: asset.name }) : t("history")}</LayerDialog.Title>
        {asset ? (
          <LayerDialog.Description>
            <span className="font-mono">{asset.code}</span> · {asset.kind}
          </LayerDialog.Description>
        ) : null}
        <LayerDialog.Body>
          {history.isError ? (
            <Failed onRetry={() => void history.refetch()} />
          ) : history.isPending ? (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 3 }, (_, at) => (
                <SkeletonLine key={at} minWidth={160} maxWidth={360} />
              ))}
            </div>
          ) : history.data.length === 0 ? (
            <Empty size="sm" icon={<ClockCounterClockwiseIcon size={32} className="text-kumo-inactive" />} title={t("historyEmpty")} />
          ) : (
            <ul className="flex flex-col">
              {history.data.map((one) => (
                <li key={one.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-kumo-hairline py-2.5 last:border-0">
                  <span className="w-28 shrink-0 tabular-nums text-kumo-subtle">{format.dateTime(new Date(one.at), "day")}</span>
                  <StatePill tone={one.issued ? "waiting" : "good"}>{one.issued ? t("wentOut") : t("cameBack")}</StatePill>
                  <Link href={`/employees/${one.employeeId}?tab=assets`} className="min-w-0 truncate text-kumo-link hover:underline">
                    {one.employee?.fullName ?? `#${one.employeeId}`}
                  </Link>
                  {one.condition ? <span className="text-kumo-subtle">{t(`condition${one.condition}`)}</span> : null}
                  {one.note ? <span className="basis-full text-kumo-subtle">{one.note}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </LayerDialog.Body>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

export function Assets({ employeeId, mayWrite }: { employeeId: number; mayWrite: boolean }) {
  const t = useTranslations("assets");
  const common = useTranslations("common");
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();

  const [issuing, setIssuing] = useState(false);
  const [returning, setReturning] = useState<Asset | null>(null);
  const [showing, setShowing] = useState<Asset | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [picked, setPicked] = useState("");
  const [condition, setCondition] = useState<Condition>("GOOD");
  const [note, setNote] = useState("");

  const held = useQuery({
    queryKey: ["assets", "held", employeeId],
    queryFn: async () => (await api.get<Asset[]>(`/employees/${employeeId}/assets`)).data,
  });

  // Only the hand-over dialog reads the shelf, and nothing on the tab filters by it.
  const stock = useQuery({
    queryKey: ["assets", "shelf"],
    enabled: issuing,
    queryFn: async () => {
      const [fresh, back] = await Promise.all([
        api.get<{ rows: Asset[] }>(`/assets?state=IN_STOCK&take=${kShelf}`),
        api.get<{ rows: Asset[] }>(`/assets?state=RETURNED&take=${kShelf}`),
      ]);
      return [...fresh.data.rows, ...back.data.rows].sort((left, right) => left.code.localeCompare(right.code));
    },
  });

  const handOver = useMutation({
    mutationFn: async (what: { asset: Asset; issued: boolean }) => {
      await api.post(`/assets/${what.asset.id}/hand-over`, {
        employeeId,
        issued: what.issued,
        condition,
        note: note || undefined,
      });
      return what;
    },
    onSuccess: (what) => {
      setIssuing(false);
      setReturning(null);
      notify.done(what.issued ? t("issuedToast", { name: what.asset.name }) : t("takenToast", { name: what.asset.name }));
      void cache.invalidateQueries({ queryKey: ["assets"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function reset(): void {
    setFault(null);
    setCondition("GOOD");
    setNote("");
  }

  function openIssue(): void {
    reset();
    setPicked("");
    setIssuing(true);
  }

  function openTake(one: Asset): void {
    reset();
    setReturning(one);
  }

  const free = stock.data ?? [];
  const chosen = free.find((one) => one.id === picked);

  const columns: Column<Asset>[] = [
    {
      id: "asset",
      header: t("asset"),
      sortBy: (row) => row.name,
      cell: (row) => (
        <span className="flex flex-col">
          <span>{row.name}</span>
          <span className="font-mono text-sm text-kumo-subtle">{row.code}</span>
        </span>
      ),
    },
    { id: "kind", header: t("kind"), sortBy: (row) => row.kind, cell: (row) => row.kind },
    {
      id: "serial",
      header: t("serial"),
      cell: (row) => (row.serialNo ? <span className="font-mono">{row.serialNo}</span> : common("empty")),
    },
  ];

  const conditionItems = Object.fromEntries(CONDITIONS.map((one) => [one, t(`condition${one}`)]));
  const faultBanner = fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} className="mt-4" /> : null;
  const conditionFields = (
    <>
      <Select
        label={t("condition")}
        hideLabel={false}
        value={condition}
        onValueChange={(next) => setCondition(String(next ?? "GOOD") as Condition)}
        items={conditionItems}
        className="w-full"
      />
      <Input label={t("note")} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
    </>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-lg font-semibold">{t("heldTitle")}</h2>
        {mayWrite ? (
          <Button variant="secondary" icon={PlusIcon} onClick={openIssue}>
            {t("issue")}
          </Button>
        ) : null}
      </div>

      <DataTable
        id="employee-assets"
        cardLead="asset"
        columns={columns}
        rows={held.data}
        keyOf={(row) => row.id}
        pending={held.isPending}
        failed={held.isError}
        onRetry={() => void held.refetch()}
        empty={t("heldEmpty")}
        emptyHint={mayWrite ? t("heldEmptyHint") : undefined}
        onRowClick={setShowing}
        rowActions={(row) => [
          { key: "history", label: t("history"), icon: ClockCounterClockwiseIcon, onSelect: () => setShowing(row) },
          ...(mayWrite ? [{ key: "take", label: t("take"), icon: ArrowUDownLeftIcon, onSelect: () => openTake(row) }] : []),
        ]}
      />

      <LayerDialog.Root open={issuing} onOpenChange={setIssuing} dismissDisabled={handOver.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("issue")}</LayerDialog.Title>
          <LayerDialog.Description>{t("issueLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            {stock.isSuccess && free.length === 0 ? (
              <Empty
                size="sm"
                icon={<PackageIcon size={32} className="text-kumo-inactive" />}
                title={t("stockEmpty")}
                description={t("stockEmptyHint")}
                contents={
                  <LinkButton href="/assets" variant="secondary">
                    {t("openRegister")}
                  </LinkButton>
                }
              />
            ) : (
              <div className="flex flex-col gap-4">
                <Select
                  label={t("pick")}
                  hideLabel={false}
                  placeholder={t("pickHint")}
                  loading={stock.isPending}
                  value={picked}
                  onValueChange={(next) => setPicked(String(next ?? ""))}
                  items={Object.fromEntries(free.map((one) => [one.id, `${one.code} · ${one.name}`]))}
                  className="w-full"
                />
                {conditionFields}
              </div>
            )}
            {faultBanner}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              loading={handOver.isPending}
              disabled={!chosen}
              onClick={() => {
                if (chosen) {
                  setFault(null);
                  handOver.mutate({ asset: chosen, issued: true });
                }
              }}
            >
              {t("issueAction")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Root
        open={returning !== null}
        onOpenChange={(next) => {
          if (!next) {
            setReturning(null);
          }
        }}
        dismissDisabled={handOver.isPending}
      >
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{returning ? t("takeTitle", { name: returning.name }) : t("take")}</LayerDialog.Title>
          <LayerDialog.Description>{t("takeLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">{conditionFields}</div>
            {faultBanner}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              loading={handOver.isPending}
              onClick={() => {
                if (returning) {
                  setFault(null);
                  handOver.mutate({ asset: returning, issued: false });
                }
              }}
            >
              {t("take")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <AssetHistory asset={showing} onClose={() => setShowing(null)} />
    </div>
  );
}
