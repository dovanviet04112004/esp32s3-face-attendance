"use client";

import { Banner, Button, Empty, LayerCard, LayerDialog, LinkButton, Select } from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon,
  ArrowUUpLeftIcon,
  CalendarBlankIcon,
  EnvelopeSimpleIcon,
  KeyIcon,
  PlusIcon,
  UserMinusIcon,
  UserCircleDashedIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useParams, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Assets } from "@/components/employees/assets";
import { Checklist } from "@/components/employees/checklist";
import { Contracts } from "@/components/employees/contracts";
import { Files } from "@/components/employees/files";
import {
  LeavingBanner,
  LeavingPill,
  Offboard,
  Outstanding,
  isOutstanding,
  useCancelLeaving,
  type Offboarding,
} from "@/components/employees/offboard";
import { Pay } from "@/components/employees/pay";
import { ShiftCard } from "@/components/employees/shifts";
import { EMPTY_DRAFT, EmployeeForm, type DepartmentChoice, type EmployeeDraft } from "@/components/forms/employee-form";
import { DataTable, type Column } from "@/components/tables/data-table";
import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill, type Tone } from "@/components/ui/pill";
import { SkeletonLine } from "@/components/ui/skeleton";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession, type Role } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { dayOnly, days } from "@/lib/format";

const TABS = ["info", "contracts", "attendance", "leave", "pay", "assets", "checklist", "files"] as const;

// Literal keys, not a built string: a missing translation has to break the build (CLAUDE.md 3.1).
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
const PAPER_DESK = ["ADMIN", "HR", "PAYROLL"];
const PEOPLE_DESK = ["ADMIN", "HR"];
const FINISHERS = ["ADMIN", "HR", "MANAGER"];
const kPunches = 20;

type Tab = (typeof TABS)[number];

interface Named {
  id: string;
  code: string;
  name: string;
}

interface Employee {
  id: number;
  code: string;
  fullName: string;
  legalEntityId: string | null;
  departmentId: string | null;
  jobTitleId: string | null;
  department: Named | null;
  jobTitle: Named | null;
  active: boolean;
  leaveDate: string | null;
  personalEmail: string | null;
  phone: string | null;
  hireDate: string | null;
  dateOfBirth: string | null;
  gender: "MALE" | "FEMALE" | null;
  nationalId: string | null;
  taxCode: string | null;
  socialInsuranceNo: string | null;
  manager: { id: number; code: string; fullName: string } | null;
  updatedAt: string;
}

interface Device {
  id: string;
  name: string | null;
  location: string | null;
}

/** Where this person stands on one kiosk (KEHOACH 7.5). */
interface Standing extends Device {
  state: "ASSIGNED" | "ENROLLED" | "RETAKE";
}

interface Punch {
  id: string;
  ts: string;
  direction: "IN" | "OUT";
  deviceId: string;
  doorOpened: boolean;
  capturedOffline: boolean;
  clockUnsynced: boolean;
  questionableTime?: boolean;
}

interface Balance {
  leaveTypeId: string;
  name: string;
  entitled: number;
  carriedOver: number;
  taken: number;
  pending: number;
  remaining: number;
}

interface LoginState {
  state: "none" | "pending" | "active" | "locked";
  email: string | null;
  role: Role | null;
  lastSeenAt: string | null;
  hasEmail: boolean;
}

interface Consent {
  id: string;
  state: "GRANTED" | "WITHDRAWN";
  noticeVersion: string;
  method: string;
  grantedAt: string;
}

const STANDING_TONE: Record<Standing["state"], Tone> = { ASSIGNED: "waiting", ENROLLED: "good", RETAKE: "waiting" };
const LOGIN_TONE: Record<LoginState["state"], Tone> = { none: "idle", pending: "waiting", active: "good", locked: "bad" };

function day(value: string | null): string {
  return value ? value.slice(0, 10) : "";
}

function draftOf(one: Employee): EmployeeDraft {
  return {
    ...EMPTY_DRAFT,
    code: one.code,
    fullName: one.fullName,
    legalEntityId: one.legalEntityId ?? "",
    departmentId: one.departmentId ?? "",
    jobTitleId: one.jobTitleId ?? "",
    personalEmail: one.personalEmail ?? "",
    phone: one.phone ?? "",
    hireDate: day(one.hireDate),
    dateOfBirth: day(one.dateOfBirth),
    gender: one.gender ?? "",
    nationalId: one.nationalId ?? "",
    taxCode: one.taxCode ?? "",
    socialInsuranceNo: one.socialInsuranceNo ?? "",
    managerId: one.manager ? String(one.manager.id) : "",
  };
}

function blankIsNull(value: string): string | null {
  return value.trim() === "" ? null : value.trim();
}

// Only what moved goes out, and an emptied field goes out as null so the record forgets it.
const PATCHED: [keyof EmployeeDraft, (value: string) => unknown][] = [
  ["code", (value) => value.trim()],
  ["fullName", (value) => value.trim()],
  ["legalEntityId", (value) => value || undefined],
  ["departmentId", blankIsNull],
  ["jobTitleId", blankIsNull],
  ["managerId", (value) => (value ? Number(value) : null)],
  ["phone", blankIsNull],
  ["hireDate", blankIsNull],
  ["dateOfBirth", blankIsNull],
  ["gender", blankIsNull],
  ["nationalId", blankIsNull],
  ["taxCode", blankIsNull],
  ["socialInsuranceNo", blankIsNull],
];

function changesOf(was: EmployeeDraft, now: EmployeeDraft): Record<string, unknown> {
  return Object.fromEntries(
    PATCHED.filter(([key]) => was[key] !== now[key]).map(([key, sent]) => [key, sent(String(now[key]))]),
  );
}

export default function EmployeePage() {
  const t = useTranslations("employees");
  const a = useTranslations("attendance");
  const roleName = useTranslations("roles");
  const common = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();
  const router = useRouter();
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const id = Number(params.id);
  const role = useSession((s) => s.role);
  const seesPapers = role !== null && PAPER_DESK.includes(role);
  const writesPeople = role !== null && PEOPLE_DESK.includes(role);
  const finishes = role !== null && FINISHERS.includes(role);

  const shown = TABS.filter((one) => (one !== "contracts" && one !== "pay") || seesPapers).filter(
    (one) => one !== "files" || writesPeople,
  );
  const asked = search.get("tab") as Tab | null;
  const tab: Tab = asked && shown.includes(asked) ? asked : "info";

  const [fault, setFault] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [left, setLeft] = useState<Offboarding | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [picked, setPicked] = useState("");
  const [enrolFault, setEnrolFault] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);

  function pick(next: string): void {
    router.replace(next === "info" ? `/employees/${id}` : `/employees/${id}?tab=${next}`, { scroll: false });
  }

  const employee = useQuery({
    queryKey: ["employees", id],
    queryFn: async () => (await api.get<Employee>(`/employees/${id}`)).data,
  });

  const departments = useQuery({
    queryKey: ["departments"],
    enabled: tab === "info" && writesPeople,
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

  // The kiosks one may assign to, which is not the fleet: that page belongs to ADMIN alone (KEHOACH 7.5).
  const devices = useQuery({
    queryKey: ["enrollments", "devices"],
    enabled: writesPeople,
    queryFn: async () => (await api.get<Device[]>("/enrollments/devices")).data,
  });

  const standing = useQuery({
    queryKey: ["enrollments", "employee", id],
    enabled: writesPeople,
    queryFn: async () => (await api.get<Standing[]>(`/enrollments/employees/${id}`)).data,
  });

  const consents = useQuery({
    queryKey: ["biometric-consents", id],
    enabled: writesPeople,
    queryFn: async () => (await api.get<Consent[]>(`/biometric-consents/${id}`)).data,
  });

  const punches = useQuery({
    queryKey: ["attendance", id, "latest"],
    enabled: tab === "attendance",
    queryFn: async () => (await api.get<{ rows: Punch[] }>(`/attendance?employeeId=${id}&take=${kPunches}`)).data.rows,
  });

  const login = useQuery({
    queryKey: ["employees", id, "login"],
    enabled: writesPeople,
    queryFn: async () => (await api.get<LoginState>(`/employees/${id}/login`)).data,
  });

  const openLogin = useMutation({
    mutationFn: async () => (await api.post<{ state: "opened" | "resent" }>(`/employees/${id}/login`, {})).data,
    onSuccess: (done) => {
      notify.done(t(done.state === "opened" ? "loginOpened" : "loginResent"));
      void cache.invalidateQueries({ queryKey: ["employees", id, "login"] });
      void cache.invalidateQueries({ queryKey: ["users"] });
    },
    onError: notify.failed,
  });

  const balances = useQuery({
    queryKey: ["leave-balances", id],
    enabled: tab === "leave",
    queryFn: async () => (await api.get<Balance[]>(`/leave-balances?employeeId=${id}`)).data,
  });

  const save = useMutation({
    mutationFn: (draft: EmployeeDraft) =>
      api.patch(`/employees/${id}`, changesOf(employee.data ? draftOf(employee.data) : EMPTY_DRAFT, draft)),
    onSuccess: () => {
      setFault(null);
      notify.done(common("saved"));
      void cache.invalidateQueries({ queryKey: ["employees"] });
      void cache.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const assign = useMutation({
    mutationFn: async (deviceId: string) =>
      (await api.post<{ state: Standing["state"] }>("/enrollments", { deviceId, employeeId: id })).data,
    onSuccess: (answer, deviceId) => {
      const device = devices.data?.find((row) => row.id === deviceId) ?? standing.data?.find((row) => row.id === deviceId);
      const name = device?.name ?? deviceId;
      setAssigning(false);
      notify.done(answer.state === "RETAKE" ? t("retakeAsked", { device: name }) : t("assigned", { device: name }));
      void cache.invalidateQueries({ queryKey: ["enrollments", "employee", id] });
    },
    onError: (fell: unknown) => (assigning ? setEnrolFault(faultOf(fell)) : notify.failed(fell)),
  });

  const agreed = consents.data?.find((one) => one.state === "GRANTED") ?? null;

  const grant = useMutation({
    mutationFn: () => api.post("/biometric-consents", { employeeId: id, method: "PAPER" }),
    onSuccess: () => {
      notify.done(t("consentGranted"));
      void cache.invalidateQueries({ queryKey: ["biometric-consents", id] });
    },
    onError: notify.failed,
  });

  const cancelLeaving = useCancelLeaving(id, employee.data?.fullName ?? "");

  const withdraw = useMutation({
    mutationFn: async () => (await api.post<{ devices: number }>(`/biometric-consents/${id}/withdraw`, {})).data,
    onSuccess: (done) => {
      setWithdrawing(false);
      notify.done(t("consentWithdrawn", { count: done.devices }));
      void cache.invalidateQueries({ queryKey: ["biometric-consents", id] });
      void cache.invalidateQueries({ queryKey: ["enrollments", "employee", id] });
    },
    onError: notify.failed,
  });

  if (employee.isError) {
    const gone = isAxiosError(employee.error) && employee.error.response?.status === 404;
    return gone ? (
      <LayerCard className="p-0">
        <Empty
          icon={<UserCircleDashedIcon size={40} className="text-kumo-inactive" />}
          title={t("notFound")}
          description={t("notFoundHint")}
          contents={
            <LinkButton href="/employees" variant="secondary">
              {t("directoryTitle")}
            </LinkButton>
          }
          className="py-12"
        />
      </LayerCard>
    ) : (
      <Failed onRetry={() => void employee.refetch()} />
    );
  }

  if (employee.isPending) {
    return (
      <div className="flex flex-col gap-4">
        <SkeletonLine minWidth={37} maxWidth={53} />
        <SkeletonLine minWidth={27} maxWidth={43} />
        <LayerCard className="mt-4 flex flex-col gap-3 p-4">
          {Array.from({ length: 5 }, (_, at) => (
            <SkeletonLine key={at} minWidth={27} maxWidth={80} />
          ))}
        </LayerCard>
      </div>
    );
  }

  const person = employee.data;
  const skipped = (search.get("skipped") ?? "").split(",").filter(Boolean);
  const working = person.active;
  const leavesOn = working ? person.leaveDate : null;
  const statePill = leavesOn ? (
    <LeavingPill leaveDate={leavesOn} />
  ) : (
    <StatePill tone={working ? "good" : "idle"}>{working ? t("statusWorking") : t("statusLeft")}</StatePill>
  );
  const lead = [person.code, person.department?.name, person.jobTitle?.name].filter(Boolean).join(" · ");
  const standingIds = new Set((standing.data ?? []).map((one) => one.id));
  const free = (devices.data ?? []).filter((one) => !standingIds.has(one.id));
  const date = (value: string | null) => (value ? format.dateTime(dayOnly(value), "day") : common("empty"));

  const punchColumns: Column<Punch>[] = [
    {
      id: "at",
      header: a("at"),
      sortBy: (row) => row.ts,
      cell: (row) => <span className="tabular-nums">{format.dateTime(new Date(row.ts), "medium")}</span>,
    },
    { id: "direction", header: a("direction"), cell: (row) => a(`direction${row.direction}`) },
    { id: "device", header: a("deviceCol"), cell: (row) => <span className="font-mono">{row.deviceId}</span> },
    {
      id: "flags",
      header: a("flags"),
      cell: (row) =>
        row.doorOpened || row.capturedOffline || row.clockUnsynced || row.questionableTime ? (
          <span className="flex flex-wrap gap-1">
            {row.questionableTime ? <StatePill tone="bad">{a("flagQuestionable")}</StatePill> : null}
            {row.doorOpened ? <StatePill>{a("flagDoor")}</StatePill> : null}
            {row.capturedOffline ? <StatePill>{a("flagOffline")}</StatePill> : null}
            {row.clockUnsynced ? <StatePill tone="waiting">{a("flagClock")}</StatePill> : null}
          </span>
        ) : (
          common("empty")
        ),
    },
  ];

  const balanceColumns: Column<Balance>[] = [
    { id: "type", header: t("leaveType"), sortBy: (row) => row.name, cell: (row) => row.name },
    {
      id: "remaining",
      header: t("leaveRemaining"),
      numeric: true,
      sortBy: (row) => row.remaining,
      cell: (row) => <span className="font-medium">{days(row.remaining, locale)}</span>,
    },
    { id: "entitled", header: t("leaveEntitled"), numeric: true, cell: (row) => days(row.entitled, locale) },
    { id: "carried", header: t("leaveCarried"), numeric: true, cell: (row) => days(row.carriedOver, locale) },
    { id: "taken", header: t("leaveTaken"), numeric: true, cell: (row) => days(row.taken, locale) },
    { id: "pending", header: t("leavePending"), numeric: true, cell: (row) => days(row.pending, locale) },
  ];

  function info() {
    if (!writesPeople) {
      return (
        <LayerCard className="max-w-(--width-read)">
          <LayerCard.Secondary>{t("personalTitle")}</LayerCard.Secondary>
          <LayerCard.Primary>
            <Facts
              rows={[
                [t("personalEmail"), person.personalEmail ?? common("empty")],
                [t("phone"), person.phone ?? common("empty")],
                [t("dateOfBirth"), date(person.dateOfBirth)],
                [t("gender"), person.gender ? t(`gender${person.gender}`) : common("empty")],
                [t("nationalId"), person.nationalId ?? common("empty")],
                [t("taxCode"), person.taxCode ?? common("empty")],
                [t("socialInsuranceNo"), person.socialInsuranceNo ?? common("empty")],
              ]}
            />
          </LayerCard.Primary>
        </LayerCard>
      );
    }
    return (
      <div>
        <EmployeeForm
          key={person.updatedAt}
          start={draftOf(person)}
          departments={departments.data ?? []}
          jobTitles={jobTitles.data ?? []}
          entities={entities.data ?? []}
          showBank={false}
          lockEmail
          showManager
          manager={person.manager}
          showOnboard={false}
          busy={save.isPending}
          fault={fault}
          onSubmit={(draft) => {
            setFault(null);
            save.mutate(draft);
          }}
        />
      </div>
    );
  }

  function panel() {
    switch (tab) {
      case "contracts":
        return <Contracts employeeId={id} mayWrite={writesPeople} />;
      case "attendance":
        return (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="m-0 text-lg font-semibold">{t("punchesTitle")}</h2>
              <LinkButton href={`/attendance/${id}`} variant="secondary">
                {common("seeAll")}
              </LinkButton>
            </div>
            <DataTable
              id="employee-punches"
              cardLead="at"
              columns={punchColumns}
              rows={punches.data}
              keyOf={(row) => row.id}
              pending={punches.isPending}
              failed={punches.isError}
              onRetry={() => void punches.refetch()}
              empty={a("historyEmpty")}
            />
          </div>
        );
      case "leave":
        return (
          <div className="flex flex-col gap-3">
            <h2 className="m-0 text-lg font-semibold">{t("leaveTitle")}</h2>
            <DataTable
              id="employee-balances"
              cardLead="type"
              columns={balanceColumns}
              rows={balances.data}
              keyOf={(row) => row.leaveTypeId}
              pending={balances.isPending}
              failed={balances.isError}
              onRetry={() => void balances.refetch()}
              empty={t("leaveEmpty")}
              emptyHint={t("leaveEmptyHint")}
            />
          </div>
        );
      case "pay":
        return <Pay employeeId={id} />;
      case "assets":
        return <Assets employeeId={id} mayWrite={writesPeople} />;
      case "checklist":
        return <Checklist employeeId={id} mayWrite={writesPeople} mayFinish={finishes} />;
      case "files":
        return <Files employeeId={id} mayWrite={writesPeople} />;
      default:
        return info();
    }
  }

  function consentCard() {
    if (consents.isPending) {
      return <SkeletonLine minWidth={27} maxWidth={43} />;
    }
    if (consents.isError) {
      return <Failed onRetry={() => void consents.refetch()} />;
    }
    if (agreed) {
      return (
        <div className="flex flex-col items-start gap-2">
          <StatePill tone="good">{t("consentOnShort")}</StatePill>
          <p className="text-kumo-subtle">
            {t("consentOn", { day: format.dateTime(new Date(agreed.grantedAt), "day") })} · {t("consentNotice")}{" "}
            {agreed.noticeVersion}
          </p>
          <Button variant="secondary-destructive" size="sm" onClick={() => setWithdrawing(true)}>
            {t("consentWithdraw")}
          </Button>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-start gap-2">
        <StatePill tone="waiting">{t("consentOffShort")}</StatePill>
        <p className="text-kumo-subtle">{t("consentMissing")}</p>
        <p className="text-sm text-kumo-subtle">{t("consentLead")}</p>
        <Button variant="secondary" size="sm" loading={grant.isPending} onClick={() => grant.mutate()}>
          {t("consentGrant")}
        </Button>
      </div>
    );
  }

  function loginCard() {
    if (login.isPending) {
      return <SkeletonLine minWidth={27} maxWidth={43} />;
    }
    if (login.isError) {
      return <Failed onRetry={() => void login.refetch()} />;
    }
    const held = login.data;
    const sends = held.state === "pending" || held.state === "active";
    return (
      <div className="flex flex-col items-start gap-2">
        <StatePill tone={LOGIN_TONE[held.state]}>{t(`login_${held.state}`)}</StatePill>
        {held.email ? (
          <p className="break-all">
            {held.email}
            {held.role ? ` · ${roleName(held.role)}` : ""}
          </p>
        ) : null}
        {held.state === "active" ? (
          <p className="text-kumo-subtle">
            {held.lastSeenAt
              ? t("loginLastSeen", { when: format.dateTime(new Date(held.lastSeenAt), "medium") })
              : t("loginNeverSeen")}
          </p>
        ) : null}
        {held.state === "none" && !working ? <p className="text-sm text-kumo-subtle">{t("loginLeftHint")}</p> : null}
        {held.state === "none" && working && !held.hasEmail ? (
          <p className="text-sm text-kumo-subtle">{t("loginNeedsEmail")}</p>
        ) : null}
        {held.state === "locked" ? (
          <p className="text-sm text-kumo-subtle">{working ? t("loginLockedHint") : t("loginLeftHint")}</p>
        ) : null}
        {held.state === "none" && working ? (
          <Button
            variant="secondary"
            size="sm"
            icon={KeyIcon}
            loading={openLogin.isPending}
            disabled={!held.hasEmail}
            onClick={() => openLogin.mutate()}
          >
            {t("loginOpen")}
          </Button>
        ) : null}
        {sends ? (
          <Button variant="secondary" size="sm" icon={EnvelopeSimpleIcon} loading={openLogin.isPending} onClick={() => openLogin.mutate()}>
            {held.state === "pending" ? t("loginResend") : t("loginSendReset")}
          </Button>
        ) : null}
      </div>
    );
  }

  function kioskCard() {
    if (standing.isError) {
      return <Failed onRetry={() => void standing.refetch()} />;
    }
    return (
      <div className="flex flex-col gap-3">
        {standing.isPending ? (
          <SkeletonLine minWidth={27} maxWidth={43} />
        ) : standing.data.length === 0 ? (
          <p className="text-kumo-subtle">{t("kioskNone")}</p>
        ) : (
          <ul className="-my-1 flex flex-col">
            {standing.data.map((kiosk) => (
              <li key={kiosk.id} className="flex items-center justify-between gap-3 border-b border-kumo-hairline py-2 last:border-0">
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="truncate">{kiosk.name ?? kiosk.id}</span>
                  <StatePill tone={STANDING_TONE[kiosk.state]} className="w-fit">
                    {t(`standing${kiosk.state}`)}
                  </StatePill>
                </span>
                {kiosk.state === "ENROLLED" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={ArrowClockwiseIcon}
                    loading={assign.isPending && assign.variables === kiosk.id}
                    onClick={() => assign.mutate(kiosk.id)}
                    className="shrink-0"
                  >
                    {t("retakeAction")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <Button
          variant="secondary"
          size="sm"
          icon={PlusIcon}
          disabled={!agreed || free.length === 0}
          onClick={() => {
            setEnrolFault(null);
            setPicked(free[0]?.id ?? "");
            setAssigning(true);
          }}
          className="self-start"
        >
          {t("assignAction")}
        </Button>
        {!consents.isPending && !agreed ? <p className="text-sm text-kumo-subtle">{t("assignNeedsConsent")}</p> : null}
        {agreed && devices.isSuccess && devices.data.length === 0 ? (
          <p className="text-sm text-kumo-subtle">{t("assignNone")}</p>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title={person.fullName}
        meta={statePill}
        description={lead}
        tabs={shown.map((one) => ({ value: one, label: t(TAB_KEY[one]) }))}
        tab={tab}
        onTab={pick}
      />

      <PageLayout
        aside={
          writesPeople ? (
            <>
              <AsideCard title={t("shiftTitle")}>
                <ShiftCard employeeId={id} fullName={person.fullName} />
              </AsideCard>
              <AsideCard title={t("consentTitle")}>{consentCard()}</AsideCard>
              <AsideCard title={t("kioskTitle")}>{kioskCard()}</AsideCard>
              <AsideCard title={t("loginTitle")}>{loginCard()}</AsideCard>
              {working && !leavesOn ? (
                <AsideCard title={t("leaveCardTitle")}>
                  <div className="flex flex-col gap-3">
                    <p className="m-0 text-sm text-kumo-subtle">{t("leaveCardLead")}</p>
                    <Button
                      variant="secondary-destructive"
                      size="sm"
                      icon={UserMinusIcon}
                      onClick={() => setLeaving(true)}
                      className="self-start"
                    >
                      {t("offboardAction")}
                    </Button>
                  </div>
                </AsideCard>
              ) : null}
            </>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-4">
          {skipped.length > 0 ? (
            <Banner
              variant="alert"
              icon={<WarningIcon weight="fill" />}
              title={t("skippedTitle", { count: skipped.length })}
              description={
                <ul className="mt-1 flex list-disc flex-col gap-0.5 ps-5">
                  {skipped.map((code) => (
                    <li key={code}>{t.has(`skipped_${code}` as never) ? t(`skipped_${code}` as never) : code}</li>
                  ))}
                </ul>
              }
              action={<Banner.Action onClick={() => pick(tab)}>{common("close")}</Banner.Action>}
            />
          ) : null}
          {leavesOn ? (
            <LeavingBanner
              leaveDate={leavesOn}
              actions={
                writesPeople ? (
                  <>
                    <Button variant="secondary" size="sm" icon={CalendarBlankIcon} onClick={() => setLeaving(true)}>
                      {t("offboardMove")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={ArrowUUpLeftIcon}
                      loading={cancelLeaving.isPending}
                      onClick={() => cancelLeaving.mutate(undefined, { onSuccess: () => setLeft(null) })}
                    >
                      {t("offboardCancel")}
                    </Button>
                  </>
                ) : undefined
              }
            />
          ) : null}
          {left && isOutstanding(left) ? (
            <Outstanding
              left={left}
              action={
                left.assetsOutstanding.length > 0 && tab !== "assets" ? (
                  <Banner.Action onClick={() => pick("assets")}>{t("offboardSeeAssets")}</Banner.Action>
                ) : undefined
              }
            />
          ) : null}
          {panel()}
        </div>
      </PageLayout>

      {writesPeople ? (
        <Offboard
          key={leavesOn ?? "open"}
          employeeId={id}
          fullName={person.fullName}
          scheduled={leavesOn}
          open={leaving}
          onOpenChange={setLeaving}
          onDone={setLeft}
        />
      ) : null}

      <LayerDialog.Root open={assigning} onOpenChange={setAssigning} dismissDisabled={assign.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("assignTitle")}</LayerDialog.Title>
          <LayerDialog.Description>{t("assignLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <Select
              label={t("kioskPick")}
              hideLabel={false}
              value={picked}
              onValueChange={(next) => setPicked(String(next ?? ""))}
              items={Object.fromEntries(free.map((one) => [one.id, one.location ? `${one.name ?? one.id} · ${one.location}` : (one.name ?? one.id)]))}
              className="w-full"
            />
            {enrolFault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={enrolFault} className="mt-4" /> : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              loading={assign.isPending}
              disabled={!picked}
              onClick={() => {
                setEnrolFault(null);
                assign.mutate(picked);
              }}
            >
              {t("assignAction")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Alert open={withdrawing} onOpenChange={setWithdrawing} dismissDisabled={withdraw.isPending}>
        <LayerDialog.Content size="sm" closeLabel={common("close")}>
          <LayerDialog.Title>{t("consentWithdrawTitle")}</LayerDialog.Title>
          <LayerDialog.Description>{t("consentWithdrawLead", { name: person.fullName })}</LayerDialog.Description>
          <LayerDialog.Body>
            <p className="text-kumo-subtle">{t("consentWithdrawHint")}</p>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary variant="destructive" loading={withdraw.isPending} onClick={() => withdraw.mutate()}>
              {t("consentWithdraw")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </>
  );
}
