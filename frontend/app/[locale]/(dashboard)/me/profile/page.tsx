"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { BottomBar } from "@/components/ui/bottom-bar";
import { Empty } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";

const FIELDS = {
  PERSONAL_EMAIL: ["personalEmail"],
  PHONE: ["phone"],
  BANK: ["bankName", "bankAccount"],
  NATIONAL_ID: ["nationalId"],
  TAX_CODE: ["taxCode"],
  SOCIAL_INSURANCE_NO: ["socialInsuranceNo"],
} as const;

type FieldName = keyof typeof FIELDS;
type Column = (typeof FIELDS)[FieldName][number];

const FIELD_NAMES = Object.keys(FIELDS) as FieldName[];

interface Change {
  id: string;
  employeeId: number;
  field: FieldName;
  state: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  oldValue: Record<string, string | null> | null;
  newValue: Record<string, string | null>;
  noticeTo: string | null;
  reason: string | null;
  note: string | null;
  createdAt: string;
  employee?: { code: string; fullName: string };
}

type Me = Partial<Record<Column, string | null>>;

function reads(values: Record<string, string | null> | null, blank: string): string {
  const shown = Object.values(values ?? {}).filter((one) => one !== null && one !== "");
  return shown.length > 0 ? shown.join(" · ") : blank;
}

export default function MyProfilePage() {
  const t = useTranslations("profile");
  const common = useTranslations("common");
  const format = useFormatter();
  const cache = useQueryClient();
  const faultOf = useFault();
  const employeeId = useSession((s) => s.employeeId);

  const [field, setField] = useState<FieldName>("BANK");
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [refused, setRefused] = useState<string | null>(null);

  const me = useQuery({
    queryKey: ["employees", employeeId],
    enabled: employeeId !== null,
    queryFn: async () => (await api.get<Me>(`/employees/${employeeId}`)).data,
  });

  const changes = useQuery({
    queryKey: ["profile-changes", "mine", employeeId],
    enabled: employeeId !== null,
    queryFn: async () =>
      (await api.get<{ rows: Change[] }>(`/profile-changes?employeeId=${employeeId}`)).data.rows,
  });

  const ask = useMutation({
    mutationFn: async () =>
      api.post("/profile-changes", {
        field,
        ...Object.fromEntries(FIELDS[field].map((one) => [one, typed[one] ?? ""])),
        ...(reason === "" ? {} : { reason }),
      }),
    onSuccess: () => {
      setTyped({});
      setReason("");
      setRefused(null);
      void cache.invalidateQueries({ queryKey: ["profile-changes"] });
    },
    onError: (fell) => setRefused(faultOf(fell)),
  });

  const cancel = useMutation({
    mutationFn: async (id: string) => api.post(`/profile-changes/${id}/cancel`, {}),
    onSuccess: () => {
      setRefused(null);
      void cache.invalidateQueries({ queryKey: ["profile-changes"] });
    },
    onError: (fell) => setRefused(faultOf(fell)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    ask.mutate();
  }

  return (
    <section className="mx-auto w-full max-w-(--width-read)">
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-(--color-muted)">{t("lead")}</p>

      <form
        onSubmit={submit}
        className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface) p-4"
      >
        <label className="block text-sm font-medium" htmlFor="field">
          {t("field")}
        </label>
        <Select
          id="field"
          value={field}
          onChange={(event) => {
            setField(event.target.value as FieldName);
            setTyped({});
          }}
          className="mt-1"
        >
          {FIELD_NAMES.map((one) => (
            <option key={one} value={one}>
              {t(`field${one}`)}
            </option>
          ))}
        </Select>

        <p className="mt-2 text-sm text-(--color-muted)">
          {t("held")}:{" "}
          <span className="tabular-nums">
            {me.isSuccess
              ? reads(
                  Object.fromEntries(FIELDS[field].map((one) => [one, me.data[one] ?? null])),
                  t("blank"),
                )
              : common("loading")}
          </span>
        </p>

        {FIELDS[field].map((one) => (
          <div key={one}>
            <label className="mt-4 block text-sm font-medium" htmlFor={one}>
              {t(one)}
            </label>
            <Input
              id={one}
              required
              value={typed[one] ?? ""}
              onChange={(event) => setTyped((held) => ({ ...held, [one]: event.target.value }))}
              className="mt-1"
            />
          </div>
        ))}

        <label className="mt-4 block text-sm font-medium" htmlFor="reason">
          {t("reason")}
        </label>
        <Input
          id="reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="mt-1"
        />

        {field === "BANK" ? (
          <p className="mt-3 text-sm text-(--color-warn)">{t("bankWarning")}</p>
        ) : null}

        {refused ? (
          <p role="alert" className="mt-3 text-sm text-(--color-danger)">
            {refused}
          </p>
        ) : null}

        <BottomBar>
          <Button type="submit" disabled={ask.isPending}>
            {ask.isPending ? t("asking") : t("ask")}
          </Button>
        </BottomBar>
      </form>

      {changes.isPending ? <Skeleton className="mt-4 h-40 w-full" /> : null}

      {changes.isSuccess && changes.data.length === 0 ? (
        <div className="mt-4">
          <Empty title={t("empty")} />
        </div>
      ) : null}

      {changes.isSuccess && changes.data.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-2">
          {changes.data.map((one) => (
            <li
              key={one.id}
              className="rounded-xl border border-(--color-line) bg-(--color-surface) p-3"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-medium">{t(`field${one.field}`)}</span>
                <span
                  className={[
                    "rounded-full px-2 py-0.5 text-xs",
                    one.state === "APPROVED"
                      ? "bg-(--color-accent) text-white"
                      : one.state === "REJECTED"
                        ? "bg-(--color-danger) text-white"
                        : "bg-(--color-ground) text-(--color-muted)",
                  ].join(" ")}
                >
                  {t(`state${one.state}`)}
                </span>
                <span className="ml-auto text-xs text-(--color-muted)">
                  {format.dateTime(new Date(one.createdAt), "day")}
                </span>
              </div>
              <p className="mt-1 text-sm">
                <span className="text-(--color-muted)">{reads(one.oldValue, t("blank"))}</span>
                {" → "}
                <span className="tabular-nums">{reads(one.newValue, t("blank"))}</span>
              </p>
              {one.employee ? (
                <p className="mt-1 text-xs text-(--color-muted)">
                  {t("person")}: {one.employee.code} · {one.employee.fullName}
                </p>
              ) : null}
              {one.noticeTo ? (
                <p className="mt-1 text-xs text-(--color-muted)">
                  {t("noticeTo")}: {one.noticeTo}
                </p>
              ) : null}
              {one.reason ? <p className="mt-1 text-sm">{one.reason}</p> : null}
              {one.note ? <p className="mt-1 text-sm text-(--color-danger)">{one.note}</p> : null}

              {one.state === "PENDING" && one.employeeId === employeeId ? (
                <Button
                  size="sm"
                  tone="quiet"
                  className="mt-3"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate(one.id)}
                >
                  {t("cancel")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
