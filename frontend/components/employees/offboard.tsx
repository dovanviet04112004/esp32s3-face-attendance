"use client";

import { Banner, Input, LayerDialog } from "@cloudflare/kumo";
import { WarningCircleIcon, WarningIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { DateField } from "@/components/ui/date-field";
import { useNotify } from "@/components/ui/notify";
import { useOptional } from "@/components/ui/optional";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";
import { dayOnly } from "@/lib/format";

export interface Offboarding {
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

export function isOutstanding(left: Offboarding): boolean {
  return left.assetsOutstanding.length > 0 || left.requestsPending > 0 || left.advancesOutstanding > 0;
}

/** What a leaver still holds or has pending, shown once the offboarding is written. */
export function Outstanding({ left, action }: { left: Offboarding; action?: ReactNode }) {
  const t = useTranslations("employees");
  const format = useFormatter();
  return (
    <Banner
      variant="alert"
      icon={<WarningIcon weight="fill" />}
      title={t("offboardLeftover", { day: format.dateTime(dayOnly(left.leaveDate), "day") })}
      description={
        <ul className="mt-1 flex list-disc flex-col gap-0.5 ps-5">
          {left.assetsOutstanding.length > 0 ? (
            <li>
              {t("offboardAssets", { count: left.assetsOutstanding.length })}:{" "}
              <span className="font-mono">{left.assetsOutstanding.map((one) => one.code).join(", ")}</span>
            </li>
          ) : null}
          {left.requestsPending > 0 ? <li>{t("offboardRequests", { count: left.requestsPending })}</li> : null}
          {left.advancesOutstanding > 0 ? <li>{t("offboardAdvances", { count: left.advancesOutstanding })}</li> : null}
        </ul>
      }
      action={action}
    />
  );
}

/** The offboarding dialog: it locks the account and erases the face on every kiosk (KEHOACH 9.14). */
export function Offboard({
  employeeId,
  fullName,
  open,
  onOpenChange,
  onDone,
}: {
  employeeId: number;
  fullName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (left: Offboarding) => void;
}) {
  const t = useTranslations("employees");
  const format = useFormatter();
  const common = useTranslations("common");
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();
  const optional = useOptional();

  const [fault, setFault] = useState<string | null>(null);
  const [leaveDate, setLeaveDate] = useState(today);
  const [reason, setReason] = useState("");

  function close(): void {
    setFault(null);
    setLeaveDate(today());
    setReason("");
    onOpenChange(false);
  }

  const leave = useMutation({
    mutationFn: async () =>
      (await api.post<Offboarding>(`/employees/${employeeId}/offboard`, { leaveDate, reason: reason || undefined })).data,
    onSuccess: (left) => {
      close();
      notify.done(t("offboardDone", { day: format.dateTime(dayOnly(left.leaveDate), "day") }));
      onDone(left);
      void cache.invalidateQueries({ queryKey: ["employees"] });
      void cache.invalidateQueries({ queryKey: ["users"] });
      void cache.invalidateQueries({ queryKey: ["assets"] });
      void cache.invalidateQueries({ queryKey: ["enrollments", "employee", employeeId] });
      void cache.invalidateQueries({ queryKey: ["biometric-consents", employeeId] });
      void cache.invalidateQueries({ queryKey: ["reports", "attention"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  return (
    <LayerDialog.Alert
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      dismissDisabled={leave.isPending}
    >
      <LayerDialog.Content closeLabel={common("close")}>
        <LayerDialog.Title>{t("offboardTitleOf", { name: fullName })}</LayerDialog.Title>
        <LayerDialog.Description>{t("offboardWarn")}</LayerDialog.Description>
        <LayerDialog.Body>
          <form
            id="offboard"
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              setFault(null);
              leave.mutate();
            }}
          >
            <DateField label={t("offboardDay")} required value={leaveDate} onChange={setLeaveDate} />
            <Input
              label={optional(t("offboardReason"))}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </form>
          {fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} className="mt-4" /> : null}
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel={common("cancel")}>
          <LayerDialog.Actions.Primary type="submit" form="offboard" variant="destructive" loading={leave.isPending}>
            {t("offboardAction")}
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Alert>
  );
}
