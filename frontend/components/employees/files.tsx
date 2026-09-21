"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { dayOnly } from "@/lib/format";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";

interface FileType {
  id: string;
  code: string;
  name: string;
  required: boolean;
  validMonths: number | null;
}

interface Named {
  typeId: string;
  code: string;
  name: string;
}

interface Gap {
  employeeId: number;
  missing: Named[];
  expired: (Named & { expiresAt: string })[];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function Files({ employeeId, mayWrite }: { employeeId: number; mayWrite: boolean }) {
  const t = useTranslations("documents");
  const format = useFormatter();
  const common = useTranslations("common");
  const cache = useQueryClient();
  const faultOf = useFault();

  const [typeId, setTypeId] = useState("");
  const [receivedAt, setReceivedAt] = useState(today);
  const [note, setNote] = useState("");
  const [fault, setFault] = useState<string | null>(null);

  const types = useQuery({
    queryKey: ["personnel-file-types"],
    queryFn: async () => (await api.get<FileType[]>("/personnel-file-types")).data,
  });

  const gaps = useQuery({
    queryKey: ["personnel-files", "gaps"],
    queryFn: async () => (await api.get<Gap[]>("/personnel-files/gaps")).data,
  });
  const mine = gaps.data?.find((one) => one.employeeId === employeeId);

  const receive = useMutation({
    mutationFn: () =>
      api.post("/personnel-files", {
        employeeId,
        typeId,
        receivedAt,
        note: note || undefined,
      }),
    onSuccess: () => {
      setNote("");
      void cache.invalidateQueries({ queryKey: ["personnel-files"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    setFault(null);
    receive.mutate();
  }

  const missing = mine?.missing ?? [];
  const expired = mine?.expired ?? [];

  return (
    <div className="mt-4 flex flex-col gap-6">
      <section>
        <h2 className="text-sm font-medium">{t("gapsHere")}</h2>
        {gaps.isPending ? (
          <p className="mt-2 text-sm text-(--color-muted)">{common("loading")}</p>
        ) : missing.length === 0 && expired.length === 0 ? (
          <p className="mt-2 text-sm text-(--color-ok)">{t("gapsClear")}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {missing.map((one) => (
              <li key={one.typeId} className="flex flex-wrap gap-2">
                <span className="font-mono text-xs text-(--color-muted)">{one.code}</span>
                <span className="min-w-0 flex-1">{one.name}</span>
                <span className="text-(--color-warn)">{t("stillMissing")}</span>
              </li>
            ))}
            {expired.map((one) => (
              <li key={one.typeId} className="flex flex-wrap gap-2">
                <span className="font-mono text-xs text-(--color-muted)">{one.code}</span>
                <span className="min-w-0 flex-1">{one.name}</span>
                <span className="text-(--color-warn)">
                  {t("expiredOn")} {format.dateTime(dayOnly(one.expiresAt), "day")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {mayWrite ? (
        <section className="max-w-md rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
          <h2 className="text-sm font-medium">{t("receiveTitle")}</h2>
          <p className="mt-1 text-sm text-(--color-muted)">{t("receiveLead")}</p>
          <form onSubmit={submit} className="mt-4">
            <label className="block text-sm font-medium" htmlFor="fileType">
              {t("fileType")}
            </label>
            <Select
              id="fileType"
              required
              value={typeId}
              onChange={(event) => setTypeId(event.target.value)}
              className="mt-1"
            >
              <option value="">{common("empty")}</option>
              {(types.data ?? []).map((one) => (
                <option key={one.id} value={one.id}>
                  {one.code} · {one.name}
                  {one.required ? ` · ${t("requiredMark")}` : ""}
                </option>
              ))}
            </Select>

            <label className="mt-4 block text-sm font-medium" htmlFor="receivedAt">
              {t("receivedAt")}
            </label>
            <Input
              id="receivedAt"
              type="date"
              required
              value={receivedAt}
              onChange={(event) => setReceivedAt(event.target.value)}
              className="mt-1"
            />
            <p className="mt-1 text-xs text-(--color-muted)">{t("expiryHint")}</p>

            <label className="mt-4 block text-sm font-medium" htmlFor="fileNote">
              {t("fileNote")}
            </label>
            <Input
              id="fileNote"
              maxLength={240}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              className="mt-1"
            />

            {fault ? (
              <p role="alert" className="mt-3 text-sm text-(--color-danger)">
                {fault}
              </p>
            ) : null}
            {receive.isSuccess && !fault ? (
              <p className="mt-3 text-sm text-(--color-ok)">{t("received")}</p>
            ) : null}
            <Button type="submit" disabled={!typeId || receive.isPending} className="mt-4">
              {receive.isPending ? common("saving") : common("save")}
            </Button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
