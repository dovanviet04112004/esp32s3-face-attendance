"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";

const CONDITIONS = ["NEW", "GOOD", "WORN", "DAMAGED"] as const;

type Condition = (typeof CONDITIONS)[number];

export interface Asset {
  id: string;
  code: string;
  name: string;
  kind: string;
  state: "IN_STOCK" | "ISSUED" | "RETURNED" | "RETIRED" | "LOST";
}

interface Transfer {
  id: string;
  issued: boolean;
  at: string;
  condition: Condition | null;
  note: string | null;
  employeeId: number;
}

export function Assets({ employeeId, mayWrite }: { employeeId: number; mayWrite: boolean }) {
  const t = useTranslations("assets");
  const format = useFormatter();
  const common = useTranslations("common");
  const cache = useQueryClient();
  const faultOf = useFault();

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

  const stock = useQuery({
    queryKey: ["assets", "stock"],
    enabled: issuing,
    queryFn: async () => (await api.get<Asset[]>("/assets?state=IN_STOCK")).data,
  });

  const history = useQuery({
    queryKey: ["assets", "history", showing?.id],
    enabled: showing !== null,
    queryFn: async () => (await api.get<Transfer[]>(`/assets/${showing?.id}/history`)).data,
  });

  const handOver = useMutation({
    mutationFn: (what: { id: string; issued: boolean }) =>
      api.post(`/assets/${what.id}/hand-over`, {
        employeeId,
        issued: what.issued,
        condition,
        note: note || undefined,
      }),
    onSuccess: () => {
      setIssuing(false);
      setReturning(null);
      setNote("");
      setPicked("");
      void cache.invalidateQueries({ queryKey: ["assets"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const free = stock.data ?? [];

  return (
    <div className="mt-4">
      {mayWrite ? (
        <Button
          type="button"
          className="mb-3"
          onClick={() => {
            setFault(null);
            setIssuing(true);
          }}
        >
          {t("issue")}
        </Button>
      ) : null}

      <div className="rounded-xl border border-(--color-line) bg-(--color-surface)">
        {held.data?.length ? (
          <ul className="divide-y divide-(--color-line)">
            {held.data.map((one) => (
              <li key={one.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                <button
                  type="button"
                  onClick={() => setShowing(one)}
                  className="text-start font-medium underline hover:no-underline"
                >
                  {one.name}
                </button>
                <span className="font-mono text-xs text-(--color-muted)">{one.code}</span>
                <span className="text-xs text-(--color-muted)">{one.kind}</span>
                {mayWrite ? (
                  <Button
                    type="button"
                    tone="quiet"
                    size="sm"
                    className="ms-auto"
                    onClick={() => {
                      setFault(null);
                      setReturning(one);
                    }}
                  >
                    {t("take")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-sm text-(--color-muted)">
            {held.isPending ? common("loading") : t("heldEmpty")}
          </p>
        )}
      </div>

      <Sheet
        open={issuing}
        onClose={() => setIssuing(false)}
        title={t("issue")}
        closeLabel={common("close")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setFault(null);
            handOver.mutate({ id: picked, issued: true });
          }}
        >
          <label className="block text-sm font-medium" htmlFor="assetPick">
            {t("pick")}
          </label>
          <Select
            id="assetPick"
            required
            value={picked}
            onChange={(event) => setPicked(event.target.value)}
            className="mt-1"
          >
            <option value="">{common("empty")}</option>
            {free.map((one) => (
              <option key={one.id} value={one.id}>
                {one.code} · {one.name}
              </option>
            ))}
          </Select>
          {stock.isSuccess && free.length === 0 ? (
            <p className="mt-2 text-sm text-(--color-muted)">{t("stockEmpty")}</p>
          ) : null}

          <label className="mt-4 block text-sm font-medium" htmlFor="assetCondition">
            {t("condition")}
          </label>
          <Select
            id="assetCondition"
            value={condition}
            onChange={(event) => setCondition(event.target.value as Condition)}
            className="mt-1"
          >
            {CONDITIONS.map((one) => (
              <option key={one} value={one}>
                {t(`condition${one}`)}
              </option>
            ))}
          </Select>

          <label className="mt-4 block text-sm font-medium" htmlFor="assetNote">
            {t("note")}
          </label>
          <Input
            id="assetNote"
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="mt-1"
          />

          {fault ? (
            <p role="alert" className="mt-3 text-sm text-(--color-danger)">
              {fault}
            </p>
          ) : null}
          <Button type="submit" disabled={!picked || handOver.isPending} className="mt-4">
            {handOver.isPending ? common("saving") : t("issue")}
          </Button>
        </form>
      </Sheet>

      <Sheet
        open={returning !== null}
        onClose={() => setReturning(null)}
        title={returning ? `${t("take")} · ${returning.name}` : t("take")}
        closeLabel={common("close")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setFault(null);
            if (returning) {
              handOver.mutate({ id: returning.id, issued: false });
            }
          }}
        >
          <label className="block text-sm font-medium" htmlFor="takeCondition">
            {t("condition")}
          </label>
          <Select
            id="takeCondition"
            value={condition}
            onChange={(event) => setCondition(event.target.value as Condition)}
            className="mt-1"
          >
            {CONDITIONS.map((one) => (
              <option key={one} value={one}>
                {t(`condition${one}`)}
              </option>
            ))}
          </Select>

          <label className="mt-4 block text-sm font-medium" htmlFor="takeNote">
            {t("note")}
          </label>
          <Input
            id="takeNote"
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="mt-1"
          />

          {fault ? (
            <p role="alert" className="mt-3 text-sm text-(--color-danger)">
              {fault}
            </p>
          ) : null}
          <Button type="submit" disabled={handOver.isPending} className="mt-4">
            {handOver.isPending ? common("saving") : t("take")}
          </Button>
        </form>
      </Sheet>

      <Sheet
        open={showing !== null}
        onClose={() => setShowing(null)}
        title={showing ? `${showing.code} · ${t("history")}` : t("history")}
        closeLabel={common("close")}
      >
        {history.data?.length ? (
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
                {one.condition ? (
                  <span className="text-(--color-muted)">{t(`condition${one.condition}`)}</span>
                ) : null}
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
    </div>
  );
}
