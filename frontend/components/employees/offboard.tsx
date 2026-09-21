"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";

interface Offboarding {
  employeeId: number;
  code: string;
  leaveDate: string;
  assetsOutstanding: { code: string; name: string }[];
  requestsPending: number;
  advancesOutstanding: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function Offboard({ employeeId }: { employeeId: number }) {
  const t = useTranslations("employees");
  const common = useTranslations("common");
  const cache = useQueryClient();
  const faultOf = useFault();

  const [open, setOpen] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [leaveDate, setLeaveDate] = useState(today);
  const [reason, setReason] = useState("");

  const leave = useMutation({
    mutationFn: async () =>
      (
        await api.post<Offboarding>(`/employees/${employeeId}/offboard`, {
          leaveDate,
          reason: reason || undefined,
        })
      ).data,
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["employees"] });
      void cache.invalidateQueries({ queryKey: ["assets"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const left = leave.data;

  return (
    <div className="mt-4 max-w-md rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
      <h2 className="text-sm font-medium">{t("offboardTitle")}</h2>
      <p className="mt-1 text-sm text-(--color-muted)">{t("offboardLead")}</p>
      <Button
        type="button"
        tone="danger"
        className="mt-4"
        onClick={() => {
          setFault(null);
          setOpen(true);
        }}
      >
        {t("offboardAction")}
      </Button>

      {left ? (
        <div className="mt-4 rounded-lg border border-(--color-line) p-3 text-sm">
          <p className="text-(--color-ok)">{t("offboardDone", { day: left.leaveDate.slice(0, 10) })}</p>
          {left.assetsOutstanding.length > 0 ? (
            <p className="mt-2 text-(--color-warn)">
              {t("offboardAssets", { count: left.assetsOutstanding.length })}:{" "}
              {left.assetsOutstanding.map((one) => one.code).join(", ")}
            </p>
          ) : null}
          {left.requestsPending > 0 ? (
            <p className="mt-1 text-(--color-warn)">
              {t("offboardRequests", { count: left.requestsPending })}
            </p>
          ) : null}
          {left.advancesOutstanding > 0 ? (
            <p className="mt-1 text-(--color-warn)">
              {t("offboardAdvances", { count: left.advancesOutstanding })}
            </p>
          ) : null}
        </div>
      ) : null}

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={t("offboardAction")}
        closeLabel={common("close")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setFault(null);
            leave.mutate(undefined, { onSuccess: () => setOpen(false) });
          }}
        >
          <p className="text-sm text-(--color-muted)">{t("offboardWarn")}</p>

          <label className="mt-4 block text-sm font-medium" htmlFor="leaveDate">
            {t("offboardDay")}
          </label>
          <Input
            id="leaveDate"
            type="date"
            required
            value={leaveDate}
            onChange={(event) => setLeaveDate(event.target.value)}
            className="mt-1"
          />

          <label className="mt-4 block text-sm font-medium" htmlFor="leaveReason">
            {t("offboardReason")}
          </label>
          <Input
            id="leaveReason"
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="mt-1"
          />

          {fault ? (
            <p role="alert" className="mt-3 text-sm text-(--color-danger)">
              {fault}
            </p>
          ) : null}
          <Button type="submit" tone="danger" disabled={leave.isPending} className="mt-4">
            {leave.isPending ? common("saving") : t("offboardAction")}
          </Button>
        </form>
      </Sheet>
    </div>
  );
}
