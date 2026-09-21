"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useFormatter, useTranslations } from "next-intl";
import { useParams, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Assets } from "@/components/employees/assets";
import { Checklist } from "@/components/employees/checklist";
import { Contracts } from "@/components/employees/contracts";
import { Files } from "@/components/employees/files";
import { Offboard } from "@/components/employees/offboard";
import { Pay } from "@/components/employees/pay";
import {
  EMPTY_DRAFT,
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
import { useFault } from "@/lib/fault";

const TABS = [
  "info",
  "contracts",
  "attendance",
  "leave",
  "pay",
  "assets",
  "checklist",
  "files",
] as const;

// Literal keys, not a built string: a missing translation has to break the
// build rather than print the key on the tab (CLAUDE.md 3.1).
const TAB_KEY = {
  info: "tabInfo",
  contracts: "tabContracts",
  attendance: "tabAttendance",
  leave: "tabLeave",
  pay: "tabPay",
  assets: "tabAssets",
  checklist: "tabChecklist",
  files: "tabFiles",
} as const;
const CONTRACT_ROLES = ["ADMIN", "HR", "PAYROLL"];
const PAY_DESK = ["ADMIN", "PAYROLL"];
const PEOPLE_DESK = ["ADMIN", "HR"];
const PUNCHES = 20;

type Tab = (typeof TABS)[number];

interface Employee {
  id: number;
  code: string;
  fullName: string;
  legalEntityId: string | null;
  departmentId: string | null;
  jobTitleId: string | null;
  active: boolean;
  personalEmail: string | null;
  phone: string | null;
  hireDate: string | null;
  dateOfBirth: string | null;
  gender: "MALE" | "FEMALE" | null;
  nationalId: string | null;
  taxCode: string | null;
  socialInsuranceNo: string | null;
}

function day(value: string | null): string {
  return value ? value.slice(0, 10) : "";
}

interface Device {
  id: string;
  name: string | null;
  location: string | null;
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

interface Consent {
  id: string;
  state: "GRANTED" | "WITHDRAWN";
  noticeVersion: string;
  method: string;
  grantedAt: string;
  withdrawnAt: string | null;
}

// One panel serves every tab, since only the open one is ever mounted.
const kPanel = "employee-tab-panel";

export default function EmployeePage() {
  const t = useTranslations("employees");
  const format = useFormatter();
  const a = useTranslations("attendance");
  const common = useTranslations("common");
  const router = useRouter();
  const cache = useQueryClient();
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const id = Number(params.id);
  const role = useSession((s) => s.role);
  const faultOf = useFault();
  const seesContracts = role !== null && CONTRACT_ROLES.includes(role);
  const mayEnrol = role !== null && PEOPLE_DESK.includes(role);
  const writesPeople = role !== null && PEOPLE_DESK.includes(role);
  const writesPay = role !== null && PAY_DESK.includes(role);

  const asked = search.get("tab") as Tab | null;
  const tab: Tab = asked && TABS.includes(asked) ? asked : "info";
  const shown = TABS.filter((one) => one !== "contracts" || seesContracts).filter(
    (one) => one !== "files" || writesPeople || role === "MANAGER",
  );

  const [fault, setFault] = useState<string | null>(null);
  const [enrolFault, setEnrolFault] = useState<string | null>(null);
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

  const jobTitles = useQuery({
    queryKey: ["job-titles"],
    enabled: tab === "info" && writesPeople,
    queryFn: async () => (await api.get<DepartmentChoice[]>("/job-titles")).data,
  });

  const entities = useQuery({
    queryKey: ["legal-entities"],
    enabled: tab === "info" && writesPeople,
    queryFn: async () => (await api.get<DepartmentChoice[]>("/legal-entities")).data,
  });

  // The enrolment desk asks which kiosks it may assign to, which is not the
  // fleet: that page belongs to ADMIN alone (KEHOACH 7.5).
  const devices = useQuery({
    queryKey: ["enrollments", "devices"],
    enabled: tab === "info" && mayEnrol,
    queryFn: async () => (await api.get<Device[]>("/enrollments/devices")).data,
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

  const save = useMutation({
    mutationFn: (draft: EmployeeDraft) =>
      api.patch(`/employees/${id}`, {
        code: draft.code,
        fullName: draft.fullName,
        legalEntityId: draft.legalEntityId || undefined,
        departmentId: draft.departmentId || undefined,
        jobTitleId: draft.jobTitleId || undefined,
        personalEmail: draft.personalEmail || undefined,
        phone: draft.phone || undefined,
        hireDate: draft.hireDate || undefined,
        dateOfBirth: draft.dateOfBirth || undefined,
        gender: draft.gender || undefined,
        nationalId: draft.nationalId || undefined,
        taxCode: draft.taxCode || undefined,
        socialInsuranceNo: draft.socialInsuranceNo || undefined,
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
    onError: (fell: unknown) => setEnrolFault(faultOf(fell)),
  });

  const consents = useQuery({
    queryKey: ["biometric-consents", id],
    enabled: tab === "info" && mayEnrol,
    queryFn: async () => (await api.get<Consent[]>(`/biometric-consents/${id}`)).data,
  });
  const agreed = consents.data?.find((one) => one.state === "GRANTED") ?? null;

  const grant = useMutation({
    mutationFn: () => api.post("/biometric-consents", { employeeId: id, method: "PAPER" }),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["biometric-consents", id] }),
  });

  const withdraw = useMutation({
    mutationFn: () => api.post(`/biometric-consents/${id}/withdraw`, {}),
    onSuccess: () => {
      setAssigned(null);
      void cache.invalidateQueries({ queryKey: ["biometric-consents", id] });
    },
  });

  const approved = devices.data ?? [];

  if (employee.isError) {
    return <Failed onRetry={() => void employee.refetch()} />;
  }
  if (employee.isPending || !employee.data) {
    return <p className="text-sm text-(--color-muted)">{common("loading")}</p>;
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
            id={`tab-${one}`}
            aria-selected={one === tab}
            aria-controls={kPanel}
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

      <div id={kPanel} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "info" ? (
          <div className="mt-6">
            <EmployeeForm
              start={{
                ...EMPTY_DRAFT,
                code: employee.data.code,
                fullName: employee.data.fullName,
                legalEntityId: employee.data.legalEntityId ?? "",
                departmentId: employee.data.departmentId ?? "",
                jobTitleId: employee.data.jobTitleId ?? "",
                active: employee.data.active,
                personalEmail: employee.data.personalEmail ?? "",
                phone: employee.data.phone ?? "",
                hireDate: day(employee.data.hireDate),
                dateOfBirth: day(employee.data.dateOfBirth),
                gender: employee.data.gender ?? "",
                nationalId: employee.data.nationalId ?? "",
                taxCode: employee.data.taxCode ?? "",
                socialInsuranceNo: employee.data.socialInsuranceNo ?? "",
              }}
              departments={departments.data ?? []}
              jobTitles={jobTitles.data ?? []}
              entities={entities.data ?? []}
              showActive
              showBank={false}
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
              <h2 className="text-sm font-medium">{t("consentTitle")}</h2>
              <p className="mt-1 text-sm text-(--color-muted)">{t("consentLead")}</p>
              {consents.isPending ? (
                <p className="mt-4 text-sm text-(--color-muted)">{common("loading")}</p>
              ) : agreed ? (
                <div className="mt-4">
                  <p className="text-sm text-(--color-ok)">
                    {t("consentOn", { day: format.dateTime(new Date(agreed.grantedAt), "day") })}
                  </p>
                  <p className="mt-1 text-xs text-(--color-muted)">
                    {t("consentNotice")} {agreed.noticeVersion} · {agreed.method}
                  </p>
                  <Button
                    type="button"
                    tone="danger"
                    className="mt-3"
                    disabled={withdraw.isPending}
                    onClick={() => withdraw.mutate()}
                  >
                    {withdraw.isPending ? common("saving") : t("consentWithdraw")}
                  </Button>
                  <p className="mt-2 text-xs text-(--color-muted)">{t("consentWithdrawHint")}</p>
                </div>
              ) : (
                <div className="mt-4">
                  <p className="text-sm text-(--color-warn)">{t("consentMissing")}</p>
                  <Button
                    type="button"
                    className="mt-3"
                    disabled={grant.isPending}
                    onClick={() => grant.mutate()}
                  >
                    {grant.isPending ? common("saving") : t("consentGrant")}
                  </Button>
                </div>
              )}
            </div>
            ) : null}

            {mayEnrol ? (
            <div className="mt-4 max-w-md rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
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
                    onClick={() => {
                      setEnrolFault(null);
                      assign.mutate(picked);
                    }}
                    className="shrink-0"
                  >
                    {t("assignAction")}
                  </Button>
                </div>
              )}
              {assigned ? (
                <p className="mt-3 text-sm text-(--color-ok)">{t("assigned", { device: assigned })}</p>
              ) : null}
              {enrolFault ? (
                <p role="alert" className="mt-3 text-sm text-(--color-danger)">
                  {enrolFault}
                </p>
              ) : null}
            </div>
            ) : null}

            {writesPeople && employee.data.active ? <Offboard employeeId={id} /> : null}
          </div>
        ) : null}

        {tab === "contracts" ? <Contracts employeeId={id} mayWrite={writesPeople} /> : null}

        {tab === "attendance" ? (
          <div className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface)">
            {punches.isPending ? (
              <p className="px-4 py-6 text-sm text-(--color-muted)">{common("loading")}</p>
            ) : punches.data?.length ? (
              <ul className="divide-y divide-(--color-line)">
                {punches.data.map((one) => (
                  <li key={one.id} className="flex flex-wrap gap-3 px-4 py-2 text-sm">
                    <span className="tabular-nums">{format.dateTime(new Date(one.ts), "medium")}</span>
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
            {balances.isPending ? (
              <p className="px-4 py-6 text-sm text-(--color-muted)">{common("loading")}</p>
            ) : balances.data?.length ? (
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

        {tab === "pay" ? <Pay employeeId={id} mayWrite={writesPay} /> : null}

        {tab === "assets" ? <Assets employeeId={id} mayWrite={writesPeople} /> : null}

        {tab === "checklist" ? <Checklist employeeId={id} mayWrite={writesPeople} /> : null}

        {tab === "files" ? <Files employeeId={id} mayWrite={writesPeople} /> : null}
      </div>
    </section>
  );
}
