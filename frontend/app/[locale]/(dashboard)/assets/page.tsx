"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";

const STATES = ["IN_STOCK", "ISSUED", "RETURNED", "RETIRED", "LOST"] as const;

type State = (typeof STATES)[number];

interface Asset {
  id: string;
  code: string;
  name: string;
  kind: string;
  serialNo: string | null;
  state: State;
  holderId: number | null;
  holder: { id: number; code: string; fullName: string } | null;
}

interface Transfer {
  id: string;
  issued: boolean;
  at: string;
  condition: string | null;
  note: string | null;
  employeeId: number;
}

export default function AssetsPage() {
  const t = useTranslations("assets");
  const format = useFormatter();
  const common = useTranslations("common");
  const cache = useQueryClient();
  const faultOf = useFault();

  const [state, setState] = useState<State | "">("");
  const [adding, setAdding] = useState(false);
  const [showing, setShowing] = useState<Asset | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("");
  const [serialNo, setSerialNo] = useState("");

  const rows = useQuery({
    queryKey: ["assets", "register", state],
    queryFn: async () => (await api.get<Asset[]>(`/assets${state ? `?state=${state}` : ""}`)).data,
  });

  const history = useQuery({
    queryKey: ["assets", "history", showing?.id],
    enabled: showing !== null,
    queryFn: async () => (await api.get<Transfer[]>(`/assets/${showing?.id}/history`)).data,
  });

  const add = useMutation({
    mutationFn: () =>
      api.post("/assets", { code, name, kind, serialNo: serialNo || undefined }),
    onSuccess: () => {
      setAdding(false);
      setCode("");
      setName("");
      setKind("");
      setSerialNo("");
      void cache.invalidateQueries({ queryKey: ["assets"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    setFault(null);
    add.mutate();
  }

  const columns: Column<Asset>[] = [
    {
      id: "asset",
      header: t("asset"),
      sticky: true,
      sortBy: (row) => row.code,
      cell: (row) => (
        <button
          type="button"
          onClick={() => setShowing(row)}
          className="text-start text-(--color-accent) hover:underline"
        >
          <span className="block">{row.name}</span>
          <span className="block font-mono text-xs text-(--color-muted)">{row.code}</span>
        </button>
      ),
    },
    { id: "kind", header: t("kind"), sortBy: (row) => row.kind, cell: (row) => row.kind },
    {
      id: "serial",
      header: t("serial"),
      cell: (row) =>
        row.serialNo ? (
          <span className="font-mono text-xs">{row.serialNo}</span>
        ) : (
          common("empty")
        ),
    },
    {
      id: "holder",
      header: t("holder"),
      sortBy: (row) => row.holder?.fullName ?? "",
      cell: (row) =>
        row.holder ? (
          <Link
            href={`/employees/${row.holder.id}?tab=assets`}
            className="text-(--color-accent) hover:underline"
          >
            {row.holder.fullName}
          </Link>
        ) : (
          common("empty")
        ),
    },
    {
      id: "state",
      header: t("state"),
      sortBy: (row) => row.state,
      cell: (row) => (
        <span className={row.state === "ISSUED" ? "text-(--color-warn)" : "text-(--color-muted)"}>
          {t(`state${row.state}`)}
        </span>
      ),
    },
  ];

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 mb-4 text-sm text-(--color-muted)">{t("lead")}</p>

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="w-48">
          <label className="block text-xs text-(--color-muted)" htmlFor="assetState">
            {t("state")}
          </label>
          <Select
            id="assetState"
            value={state}
            onChange={(event) => setState(event.target.value as State | "")}
            className="mt-1"
          >
            <option value="">{t("anyState")}</option>
            {STATES.map((one) => (
              <option key={one} value={one}>
                {t(`state${one}`)}
              </option>
            ))}
          </Select>
        </div>
        <Button
          type="button"
          onClick={() => {
            setFault(null);
            setAdding(true);
          }}
        >
          {t("add")}
        </Button>
      </div>

      <DataTable
        id="assets"
        columns={columns}
        rows={rows.data}
        keyOf={(row) => row.id}
        pending={rows.isPending}
        failed={rows.isError}
        onRetry={() => rows.refetch()}
        empty={t("registerEmpty")}
        emptyHint={t("registerEmptyHint")}
      />

      <Sheet
        open={adding}
        onClose={() => setAdding(false)}
        title={t("add")}
        closeLabel={common("close")}
      >
        <form onSubmit={submit}>
          <label className="block text-sm font-medium" htmlFor="assetCode">
            {t("code")}
          </label>
          <Input
            id="assetCode"
            required
            maxLength={32}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            className="mt-1"
          />

          <label className="mt-4 block text-sm font-medium" htmlFor="assetName">
            {t("name")}
          </label>
          <Input
            id="assetName"
            required
            maxLength={160}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-1"
          />

          <label className="mt-4 block text-sm font-medium" htmlFor="assetKind">
            {t("kind")}
          </label>
          <Input
            id="assetKind"
            required
            maxLength={32}
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className="mt-1"
          />

          <label className="mt-4 block text-sm font-medium" htmlFor="assetSerial">
            {t("serial")}
          </label>
          <Input
            id="assetSerial"
            maxLength={64}
            value={serialNo}
            onChange={(event) => setSerialNo(event.target.value)}
            className="mt-1"
          />

          {fault ? (
            <p role="alert" className="mt-3 text-sm text-(--color-danger)">
              {fault}
            </p>
          ) : null}
          <Button type="submit" disabled={add.isPending} className="mt-4">
            {add.isPending ? common("saving") : common("save")}
          </Button>
        </form>
      </Sheet>

      <Sheet
        open={showing !== null}
        onClose={() => setShowing(null)}
        title={showing ? `${showing.code} · ${t("history")}` : t("history")}
        closeLabel={common("close")}
      >
        {history.isPending ? (
          <p className="px-4 py-6 text-sm text-(--color-muted)">{common("loading")}</p>
        ) : history.data?.length ? (
          <ul className="flex flex-col">
            {history.data.map((one) => (
              <li
                key={one.id}
                className="flex flex-wrap gap-x-3 gap-y-1 border-b border-(--color-line) py-2 text-sm last:border-0"
              >
                <span className="tabular-nums">{format.dateTime(new Date(one.at), "day")}</span>
                <span className={one.issued ? "text-(--color-warn)" : "text-(--color-ok)"}>
                  {one.issued ? t("wentOut") : t("cameBack")}
                </span>
                <Link
                  href={`/employees/${one.employeeId}?tab=assets`}
                  className="text-(--color-accent) hover:underline"
                >
                  #{one.employeeId}
                </Link>
                {one.note ? <span className="text-xs text-(--color-muted)">{one.note}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-(--color-muted)">
            {history.isPending ? common("loading") : t("historyEmpty")}
          </p>
        )}
      </Sheet>
    </section>
  );
}
