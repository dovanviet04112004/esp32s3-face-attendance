"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useLocale, useTranslations } from "next-intl";
import { useParams, useSearchParams } from "next/navigation";
import { useState } from "react";

import {
  EmployeeForm,
  type DepartmentChoice,
  type EmployeeDraft,
} from "@/components/forms/employee-form";
import { Failed } from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { money } from "@/lib/format";

const TABS = ["info", "contracts", "attendance", "leave", "pay", "assets"] as const;

// Literal keys, not a built string: a missing translation has to break the
// build rather than print the key on the tab (CLAUDE.md 3.1).
const TAB_KEY = {
  info: "tabInfo",
  contracts: "tabContracts",
  attendance: "tabAttendance",
  leave: "tabLeave",
  pay: "tabPay",
  assets: "tabAssets",
} as const;
const CONTRACT_ROLES = ["ADMIN", "HR", "PAYROLL"];
const ENROL_DESK = ["ADMIN", "HR"];
const PUNCHES = 20;

type Tab = (typeof TABS)[number];

interface Employee {
  id: number;
  code: string;
  fullName: string;
  departmentId: string | null;
  active: boolean;
}

interface Device {
  id: string;
  name: string | null;
  location: string | null;
}

interface Contract {
  id: string;
  kind: "PROBATION" | "FIXED_TERM" | "INDEFINITE" | "SEASONAL" | "INTERNSHIP";
  state: "DRAFT" | "ACTIVE" | "ENDED" | "TERMINATED";
  startDate: string;
  endDate: string | null;
  probationEnd: string | null;
}

interface Punch {
  id: string;
  ts: string;
  direction: string;
  deviceId: string;
}

interface Balance {
  leaveTypeId: string;
  name: string;
  remaining: number;
}

interface PayRecord {
  id: string;
  effectiveFrom: string;
  baseSalary: string;
  insuranceSalary: string;
}

interface PayslipRow {
  id: string;
  netPay: string;
  period?: { year: number; month: number };
}

interface Asset {
  id: string;
  code: string;
  name: string;
  kind: string;
}

function day(value: string | null): string {
  return value ? value.slice(0, 10) : "";
}

export default function EmployeePage() {
  const t = useTranslations("employees");
  const a = useTranslations("attendance");
  const common = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const cache = useQueryClient();
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const id = Number(params.id);
  const role = useSession((s) => s.role);
  const seesContracts = role !== null && CONTRACT_ROLES.includes(role);
  const mayEnrol = role !== null && ENROL_DESK.includes(role);

  const asked = search.get("tab") as Tab | null;
  const tab: Tab = asked && TABS.includes(asked) ? asked : "info";
  const shown = TABS.filter((one) => one !== "contracts" || seesContracts);

  const [fault, setFault] = useState<string | null>(null);
  const [picked, setPicked] = useState("");
  const [assigned, setAssigned] = useState<string | null>(null);

  const employee = useQuery({
    queryKey: ["employees", id],
    queryFn: async () => (await api.get<Employee>(`/employees/${id}`)).data,
  });

  const departments = useQuery({
    queryKey: ["departments"],
    enabled: tab === "info",
    queryFn: async () => (await api.get<DepartmentChoice[]>("/departments")).data,
  });

  // The enrolment desk asks which kiosks it may assign to, which is not the
  // fleet: that page belongs to ADMIN alone (KEHOACH 7.5).
  const devices = useQuery({
    queryKey: ["enrollments", "devices"],
    enabled: tab === "info" && mayEnrol,
    queryFn: async () => (await api.get<Device[]>("/enrollments/devices")).data,
  });

  const contracts = useQuery({
    queryKey: ["contracts", id],
    enabled: tab === "contracts" && seesContracts,
    queryFn: async () => (await api.get<Contract[]>(`/employees/${id}/contracts`)).data,
  });

  const punches = useQuery({
    queryKey: ["attendance", id],
    enabled: tab === "attendance",
    queryFn: async () =>
      (await api.get<{ rows: Punch[] }>(`/attendance?employeeId=${id}&take=${PUNCHES}`)).data.rows,
  });

  const balances = useQuery({
    queryKey: ["leave-balances", id],
    enabled: tab === "leave",
    queryFn: async () => (await api.get<Balance[]>(`/leave-balances?employeeId=${id}`)).data,
  });

  const pay = useQuery({
    queryKey: ["compensation", id],
    enabled: tab === "pay",
    queryFn: async () => (await api.get<PayRecord[]>(`/employees/${id}/compensation`)).data,
  });

  const payslips = useQuery({
    queryKey: ["payslips", "of", id],
    enabled: tab === "pay",
    queryFn: async () => (await api.get<PayslipRow[]>(`/payslips?employeeId=${id}`)).data,
  });

  const assets = useQuery({
    queryKey: ["assets", id],
    enabled: tab === "assets",
    queryFn: async () => (await api.get<Asset[]>(`/employees/${id}/assets`)).data,
  });

  const save = useMutation({
    mutationFn: (draft: EmployeeDraft) =>
      api.patch(`/employees/${id}`, {
        code: draft.code,
        fullName: draft.fullName,
        departmentId: draft.departmentId || undefined,
        active: draft.active,
      }),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["employees"] });
      router.replace("/employees");
    },
    onError: (fell: unknown) => {
      const clash = isAxiosError(fell) && fell.response?.status === 409;
      setFault(clash ? t("codeTaken") : common("failed"));
    },
  });

  const assign = useMutation({
    mutationFn: (deviceId: string) => api.post("/enrollments", { deviceId, employeeId: id }),
    onSuccess: (_answer, deviceId) => {
      const device = devices.data?.find((row) => row.id === deviceId);
      setAssigned(device?.name ?? deviceId);
    },
  });

  const approved = devices.data ?? [];

  if (employee.isPending) {
    return <p className="text-sm text-(--color-muted)">{common("loading")}</p>;
  }
  if (!employee.data) {
    return <p className="text-sm text-(--color-danger)">{common("failed")}</p>;
  }

  if (employee.isError) {
    return <Failed onRetry={() => void employee.refetch()} />;
  }

  return (
    <section className="mx-auto w-full max-w-(--width-read)">
      <h1 className="text-lg font-semibold">{employee.data.fullName}</h1>
      <p className="mt-1 text-sm text-(--color-muted)">
        {employee.data.code} · {employee.data.active ? t("working") : t("left")}
      </p>

      <div
        role="tablist"
        className="mt-4 flex gap-1 overflow-x-auto border-b border-(--color-line)"
      >
        {shown.map((one) => (
          <button
            key={one}
            type="button"
            role="tab"
            aria-selected={one === tab}
            onClick={() => router.replace(`/employees/${id}?tab=${one}`)}
            className={[
              "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm",
              one === tab
                ? "border-(--color-accent) font-medium"
                : "border-transparent text-(--color-muted) hover:text-(--color-ink)",
            ].join(" ")}
          >
            {t(TAB_KEY[one])}
          </button>
        ))}
      </div>

      {tab === "info" ? (
        <div className="mt-6">
          <EmployeeForm
            start={{
              code: employee.data.code,
              fullName: employee.data.fullName,
              departmentId: employee.data.departmentId ?? "",
              active: employee.data.active,
            }}
            departments={departments.data ?? []}
            showActive
            busy={save.isPending}
            fault={fault}
            onSubmit={(draft) => {
              setFault(null);
              save.mutate(draft);
            }}
            onCancel={() => router.replace("/employees")}
          />

          {mayEnrol ? (
          <div className="mt-10 max-w-md rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
            <h2 className="text-sm font-medium">{t("assignTitle")}</h2>
            <p className="mt-1 text-sm text-(--color-muted)">{t("assignLead")}</p>
            {approved.length === 0 ? (
              <p className="mt-4 text-sm text-(--color-muted)">{t("assignNone")}</p>
            ) : (
              <div className="mt-4 flex gap-2">
                <Select
                  aria-label={t("assignTitle")}
                  value={picked}
                  onChange={(e) => setPicked(e.target.value)}
                >
                  <option value="">{common("empty")}</option>
                  {approved.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.name ?? device.id}
                    </option>
                  ))}
                </Select>
                <Button
                  type="button"
                  disabled={!picked || assign.isPending}
                  onClick={() => assign.mutate(picked)}
                  className="shrink-0"
                >
                  {t("assignAction")}
                </Button>
              </div>
            )}
            {assigned ? (
              <p className="mt-3 text-sm text-(--color-ok)">{t("assigned", { device: assigned })}</p>
            ) : null}
          </div>
          ) : null}
        </div>
      ) : null}

      {tab === "contracts" ? (
        <div className="mt-4">
          {contracts.data?.length ? (
            <ul className="flex flex-col gap-2">
              {contracts.data.map((one) => (
                <li
                  key={one.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-(--color-line) bg-(--color-surface) p-3 text-sm"
                >
                  <span className="font-medium">{t(`contract${one.kind}`)}</span>
                  <span className="text-(--color-muted)">{t(`contract${one.state}`)}</span>
                  <span className="tabular-nums">
                    {day(one.startDate)} → {one.endDate ? day(one.endDate) : t("contractOpen")}
                  </span>
                  {one.probationEnd ? (
                    <span className="text-xs text-(--color-muted)">
                      {t("probationEnds")} {day(one.probationEnd)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-(--color-muted)">
              {contracts.isPending ? common("loading") : t("contractsEmpty")}
            </p>
          )}
        </div>
      ) : null}

      {tab === "attendance" ? (
        <div className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface)">
          {punches.data?.length ? (
            <ul className="divide-y divide-(--color-line)">
              {punches.data.map((one) => (
                <li key={one.id} className="flex flex-wrap gap-3 px-4 py-2 text-sm">
                  <span className="tabular-nums">{one.ts.replace("T", " ").slice(0, 19)}</span>
                  <span className="text-(--color-muted)">{one.direction}</span>
                  <span className="ml-auto text-xs text-(--color-muted)">{one.deviceId}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-6 text-sm text-(--color-muted)">
              {punches.isPending ? common("loading") : a("historyEmpty")}
            </p>
          )}
        </div>
      ) : null}

      {tab === "leave" ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {balances.data?.length ? (
            balances.data.map((one) => (
              <article
                key={one.leaveTypeId}
                className="rounded-xl border border-(--color-line) bg-(--color-surface) p-4"
              >
                <p className="text-xs text-(--color-muted)">{one.name}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{one.remaining}</p>
              </article>
            ))
          ) : (
            <p className="text-sm text-(--color-muted)">
              {balances.isPending ? common("loading") : t("leaveEmpty")}
            </p>
          )}
        </div>
      ) : null}

      {tab === "pay" ? (
        <div className="mt-4 flex flex-col gap-6">
          <section>
            <h2 className="text-sm font-medium">{t("payHistory")}</h2>
            <div className="mt-2 rounded-xl border border-(--color-line) bg-(--color-surface)">
              {pay.data?.length ? (
                <ul className="divide-y divide-(--color-line)">
                  {pay.data.map((one) => (
                    <li key={one.id} className="flex flex-wrap gap-3 px-4 py-2 text-sm">
                      <span className="tabular-nums">{day(one.effectiveFrom)}</span>
                      <span className="ml-auto tabular-nums">
                        {t("payBase")} {money(Number(one.baseSalary), locale)}
                      </span>
                      <span className="tabular-nums text-(--color-muted)">
                        {t("payInsurance")} {money(Number(one.insuranceSalary), locale)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-6 text-sm text-(--color-muted)">
                  {pay.isPending ? common("loading") : t("payEmpty")}
                </p>
              )}
            </div>
          </section>

          <section>
            <h2 className="text-sm font-medium">{t("payslipsHere")}</h2>
            <div className="mt-2 rounded-xl border border-(--color-line) bg-(--color-surface)">
              {payslips.data?.length ? (
                <ul className="divide-y divide-(--color-line)">
                  {payslips.data.map((one) => (
                    <li key={one.id} className="flex gap-3 px-4 py-2 text-sm">
                      <span className="tabular-nums">
                        {one.period ? `${one.period.month}/${one.period.year}` : ""}
                      </span>
                      <span className="ml-auto tabular-nums">
                        {money(Number(one.netPay), locale)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-6 text-sm text-(--color-muted)">
                  {payslips.isPending ? common("loading") : t("payslipsEmpty")}
                </p>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {tab === "assets" ? (
        <div className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface)">
          {assets.data?.length ? (
            <ul className="divide-y divide-(--color-line)">
              {assets.data.map((one) => (
                <li key={one.id} className="flex flex-wrap gap-3 px-4 py-2 text-sm">
                  <span className="font-medium">{one.name}</span>
                  <span className="text-(--color-muted)">{one.code}</span>
                  <span className="ml-auto text-xs text-(--color-muted)">{one.kind}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-6 text-sm text-(--color-muted)">
              {assets.isPending ? common("loading") : t("assetsEmpty")}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
