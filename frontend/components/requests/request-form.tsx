"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { BottomBar } from "@/components/ui/bottom-bar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";
import { keep } from "@/lib/outbox";
import type { RequestKind } from "./request-card";

const KINDS: RequestKind[] = [
  "LEAVE",
  "OVERTIME",
  "ATTENDANCE_FIX",
  "BUSINESS_TRIP",
  "REMOTE_WORK",
];

interface LeaveType {
  id: string;
  code: string;
  name: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function RequestForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const t = useTranslations("requests");
  const common = useTranslations("common");
  const faultOf = useFault();
  const [kind, setKind] = useState<RequestKind>("LEAVE");
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [fromDate, setFromDate] = useState(today());
  const [toDate, setToDate] = useState(today());
  const [halfDay, setHalfDay] = useState(false);
  const [minutes, setMinutes] = useState("");
  const [reason, setReason] = useState("");
  const [fault, setFault] = useState<string | null>(null);
  // The api rejects a backwards span, and the form can say so without asking.
  const backwards = toDate < fromDate;

  const types = useQuery({
    queryKey: ["leave-types"],
    queryFn: async () => (await api.get<LeaveType[]>("/leave-types")).data,
  });

  const file = useMutation({
    mutationFn: async () => {
      const body = {
        kind,
        leaveTypeId: kind === "LEAVE" ? leaveTypeId : undefined,
        fromDate,
        toDate,
        halfDay: kind === "LEAVE" ? halfDay : undefined,
        minutes: minutes ? Number(minutes) : undefined,
        reason,
      };
      const clientKey = crypto.randomUUID();
      try {
        return await api.post("/requests", { ...body, clientKey });
      } catch (fell) {
        // No response at all means nobody refused it, so it waits rather than
        // being lost (KEHOACH 9.21.3 rule 2).
        if ((fell as { response?: unknown }).response !== undefined) {
          throw fell;
        }
        await keep({ clientKey, path: "/requests", body, filedAt: Date.now() });
        return null;
      }
    },
    onSuccess: onDone,
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setFault(null);
    file.mutate();
  }

  const wantsMinutes = kind === "OVERTIME" || kind === "ATTENDANCE_FIX";

  return (
    <form
      onSubmit={submit}
      className="rounded-xl border border-(--color-line) bg-(--color-surface) p-4"
    >
      <label className="block text-sm font-medium" htmlFor="kind">
        {t("kind")}
      </label>
      <Select
        id="kind"
        value={kind}
        onChange={(e) => setKind(e.target.value as RequestKind)}
        className="mt-1"
      >
        {KINDS.map((one) => (
          <option key={one} value={one}>
            {t(`kind${one}`)}
          </option>
        ))}
      </Select>

      {kind === "LEAVE" ? (
        <>
          <label className="mt-4 block text-sm font-medium" htmlFor="leaveType">
            {t("leaveType")}
          </label>
          <Select
            id="leaveType"
            required
            value={leaveTypeId}
            onChange={(e) => setLeaveTypeId(e.target.value)}
            className="mt-1"
          >
            <option value="">{common("empty")}</option>
            {(types.data ?? []).map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </Select>
        </>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-3">
        <div className="flex-1">
          <label className="block text-sm font-medium" htmlFor="fromDate">
            {t("from")}
          </label>
          <Input
            id="fromDate"
            type="date"
            required
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="mt-1"
          />
        </div>
        <div className="flex-1">
          <label className="block text-sm font-medium" htmlFor="toDate">
            {t("to")}
          </label>
          <Input
            id="toDate"
            type="date"
            required
            min={fromDate}
            aria-invalid={backwards}
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="mt-1"
          />
        </div>
      </div>
      {backwards ? (
        <p className="mt-1 text-xs text-(--color-danger)">{t("backwards")}</p>
      ) : null}

      {kind === "LEAVE" ? (
        <Checkbox
          className="mt-4"
          checked={halfDay}
          onChange={(e) => setHalfDay(e.target.checked)}
          label={t("halfDay")}
        />
      ) : null}

      {wantsMinutes ? (
        <>
          <label className="mt-4 block text-sm font-medium" htmlFor="minutes">
            {t("minutes")}
          </label>
          <Input
            id="minutes"
            type="number"
            min={0}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            className="mt-1"
          />
        </>
      ) : null}

      <label className="mt-4 block text-sm font-medium" htmlFor="reason">
        {t("reason")}
      </label>
      <textarea
        id="reason"
        required
        rows={3}
        maxLength={500}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="mt-1 w-full rounded-lg border border-(--color-field) bg-(--color-surface) p-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-accent)"
      />

      {fault ? (
        <p role="alert" className="mt-4 text-sm text-(--color-danger)">
          {fault}
        </p>
      ) : null}

      <BottomBar>
        <Button type="submit" disabled={file.isPending || backwards}>
          {file.isPending ? t("submitting") : t("submit")}
        </Button>
        <Button type="button" tone="quiet" onClick={onCancel}>
          {common("cancel")}
        </Button>
      </BottomBar>
    </form>
  );
}
