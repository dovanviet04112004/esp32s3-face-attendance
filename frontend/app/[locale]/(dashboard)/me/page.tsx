"use client";

import { Banner, Button, Empty, Input, Label, LayerCard, LayerDialog, LinkButton, Select, SkeletonLine } from "@cloudflare/kumo";
import {
  CalendarPlusIcon,
  FileTextIcon,
  PlusIcon,
  ReceiptIcon,
  TrayIcon,
  UserCircleIcon,
  UsersThreeIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState, type FormEvent, type ReactNode } from "react";

import type { RequestRow } from "@/components/requests/request-card";
import { RequestForm, todayHere } from "@/components/requests/request-form";
import { Failed } from "@/components/ui/failed";
import { MonthPicker, thisMonth, type Month } from "@/components/ui/month-picker";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill, type Tone } from "@/components/ui/pill";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { dayOnly, days, money } from "@/lib/format";

interface Balance {
  leaveTypeId: string;
  name: string;
  remaining: number;
  bookedAfter: number;
}

const RELATIONS = ["CHILD", "SPOUSE", "PARENT", "SIBLING", "OTHER"] as const;
type Relation = (typeof RELATIONS)[number];
type DependentState = "PENDING" | "ACTIVE" | "REJECTED" | "ENDED";

interface Dependent {
  id: string;
  fullName: string;
  relation: Relation;
  fromMonth: string;
  state: DependentState;
}

interface Me {
  id: number;
  code: string;
  fullName: string;
  department: { id: string; name: string } | null;
}

interface PlannedDay {
  date: string;
  shift: { id: string; name: string; startTime: string; endTime: string } | null;
  holiday: string | null;
  weekend: boolean;
  away: string | null;
}

interface Punch {
  id: string;
  ts: string;
  direction: "IN" | "OUT";
}

interface PayslipRow {
  id: string;
  netPay: string;
  period?: { year: number; month: number };
}

const DEPENDENT_TONE: Record<DependentState, Tone> = {
  PENDING: "waiting",
  ACTIVE: "good",
  REJECTED: "bad",
  ENDED: "idle",
};

const kDependentForm = "dependent-form";
const kDayMs = 86_400_000;
const kPunchesShown = 20;

function waited(since: string): number {
  return Math.floor((Date.now() - new Date(since).getTime()) / kDayMs);
}

function monthStart(at: Month): string {
  return `${at.year}-${String(at.month).padStart(2, "0")}-01`;
}

function TodayPart({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="text-sm font-medium text-kumo-subtle">{label}</p>
      {children}
    </div>
  );
}

function CardHead({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <LayerCard.Secondary className="justify-between gap-3">
      <span>{title}</span>
      {action}
    </LayerCard.Secondary>
  );
}

function Waiting() {
  return (
    <div className="flex flex-col gap-2">
      <SkeletonLine minWidth={25} maxWidth={43} />
      <SkeletonLine minWidth={25} maxWidth={35} />
    </div>
  );
}

export default function MyPage() {
  const t = useTranslations("me");
  const r = useTranslations("requests");
  const shifts = useTranslations("myShifts");
  const a = useTranslations("attendance");
  const pay = useTranslations("payroll");
  const common = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();
  const notify = useNotify();
  const faultOf = useFault();
  const cache = useQueryClient();
  const employeeId = useSession((s) => s.employeeId);
  const today = todayHere();
  const month = thisMonth();

  const [asOf, setAsOf] = useState(today);
  const [seed, setSeed] = useState(0);
  const [filing, setFiling] = useState(false);
  const [declaring, setDeclaring] = useState(false);
  const [dependentName, setDependentName] = useState("");
  const [relation, setRelation] = useState<Relation>("CHILD");
  const [fromMonth, setFromMonth] = useState<Month>(month);
  const [fault, setFault] = useState<string | null>(null);

  const me = useQuery({
    queryKey: ["employees", employeeId],
    enabled: employeeId !== null,
    queryFn: async () => (await api.get<Me>(`/employees/${employeeId}`)).data,
  });

  const roster = useQuery({
    queryKey: ["me", "roster", month.year, month.month],
    enabled: employeeId !== null,
    queryFn: async () =>
      (await api.get<PlannedDay[]>(`/shifts/roster?year=${month.year}&month=${month.month}`)).data,
  });

  const punches = useQuery({
    queryKey: ["attendance", "mine", employeeId, "day", today],
    enabled: employeeId !== null,
    queryFn: async () => {
      const [year, monthNo, day] = today.split("-").map(Number);
      const from = new Date(year, monthNo - 1, day).toISOString();
      const to = new Date(year, monthNo - 1, day + 1).toISOString();
      const query = new URLSearchParams({ employeeId: String(employeeId), from, to, take: String(kPunchesShown) });
      const rows = (await api.get<{ rows: Punch[] }>(`/attendance?${query.toString()}`)).data.rows;
      return [...rows].sort((left, right) => left.ts.localeCompare(right.ts));
    },
  });

  const balances = useQuery({
    queryKey: ["leave-balances", asOf],
    enabled: employeeId !== null,
    queryFn: async () => (await api.get<Balance[]>(`/leave-balances?asOf=${asOf}`)).data,
  });

  const requests = useQuery({
    queryKey: ["requests", "mine", employeeId],
    enabled: employeeId !== null,
    queryFn: async () =>
      (await api.get<{ rows: RequestRow[]; total: number }>(`/requests?employeeId=${employeeId}`)).data,
  });

  const latest = useQuery({
    queryKey: ["payslips", "mine", employeeId, "latest"],
    enabled: employeeId !== null,
    queryFn: async () =>
      (await api.get<{ rows: PayslipRow[] }>(`/payslips?employeeId=${employeeId}&take=1`)).data.rows[0] ?? null,
  });

  const dependents = useQuery({
    queryKey: ["dependents", employeeId],
    enabled: employeeId !== null,
    queryFn: async () => (await api.get<Dependent[]>(`/employees/${employeeId}/dependents`)).data,
  });

  const addDependent = useMutation({
    mutationFn: () => api.post("/dependents", { fullName: dependentName, relation, fromMonth: monthStart(fromMonth) }),
    onSuccess: () => {
      notify.done(t("dependentAdded"));
      setDeclaring(false);
      void cache.invalidateQueries({ queryKey: ["dependents"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function openForm(): void {
    setSeed((held) => held + 1);
    setFiling(true);
  }

  function openDeclare(): void {
    setDependentName("");
    setRelation("CHILD");
    setFromMonth(month);
    setFault(null);
    setDeclaring(true);
  }

  function awayLabel(kind: string): string {
    if (kind === "BUSINESS_TRIP") {
      return shifts("awayBUSINESS_TRIP");
    }
    return kind === "REMOTE_WORK" ? shifts("awayREMOTE_WORK") : shifts("awayLEAVE");
  }

  if (employeeId === null) {
    return (
      <>
        <PageHeader title={t("title")} />
        <LayerCard className="p-0">
          <Empty icon={<UserCircleIcon size={40} className="text-kumo-inactive" />} title={t("noProfile")} className="py-12" />
        </LayerCard>
      </>
    );
  }

  const planned = roster.data?.find((one) => one.date.slice(0, 10) === today);
  const pending = (requests.data?.rows ?? []).filter((row) => row.state === "PENDING");
  const clock = (iso: string) => format.dateTime(new Date(iso), "clock");

  const shiftToday = planned?.holiday ? (
    <p className="font-medium">
      {t("holidayToday")}: {planned.holiday}
    </p>
  ) : planned?.away ? (
    <p className="font-medium">{awayLabel(planned.away)}</p>
  ) : planned?.weekend ? (
    <p className="font-medium">{t("weekendToday")}</p>
  ) : planned?.shift ? (
    <p className="flex flex-wrap items-baseline gap-x-2">
      <span className="text-lg font-semibold tabular-nums">
        {planned.shift.startTime}–{planned.shift.endTime}
      </span>
      <span className="text-kumo-subtle">{planned.shift.name}</span>
    </p>
  ) : (
    <p className="text-kumo-subtle">{shifts("none")}</p>
  );

  return (
    <>
      <PageHeader
        title={me.data ? t("greeting", { name: me.data.fullName }) : t("title")}
        description={me.data ? `${me.data.code}${me.data.department ? ` · ${me.data.department.name}` : ""}` : undefined}
        actions={
          <Button variant="primary" icon={CalendarPlusIcon} onClick={openForm}>
            {t("askLeave")}
          </Button>
        }
      />

      <PageLayout
        aside={
          <>
            <AsideCard title={common("shortcuts")}>
              <div className="flex flex-col gap-2">
                <LinkButton href="/me/letters?new=1" variant="secondary" icon={FileTextIcon} className="w-full justify-start">
                  {t("askLetter")}
                </LinkButton>
                <LinkButton href="/me/profile?new=1" variant="secondary" icon={UserCircleIcon} className="w-full justify-start">
                  {t("askProfile")}
                </LinkButton>
              </div>
            </AsideCard>
            <AsideCard
              title={t("dependentsTitle")}
              action={
                dependents.data?.length ? (
                  <Button variant="ghost" size="sm" icon={PlusIcon} onClick={openDeclare}>
                    {t("dependentAddShort")}
                  </Button>
                ) : undefined
              }
            >
              {dependents.isPending ? (
                <Waiting />
              ) : dependents.isError ? (
                <Failed onRetry={() => void dependents.refetch()} />
              ) : dependents.data.length === 0 ? (
                <Empty
                  size="sm"
                  icon={<UsersThreeIcon size={32} className="text-kumo-inactive" />}
                  title={t("dependentsEmpty")}
                  description={t("dependentsEmptyHint")}
                  contents={
                    <Button variant="secondary" icon={PlusIcon} onClick={openDeclare}>
                      {t("dependentAdd")}
                    </Button>
                  }
                />
              ) : (
                <ul className="-my-1 flex flex-col">
                  {dependents.data.map((one) => (
                    <li key={one.id} className="flex items-center justify-between gap-3 border-b border-kumo-hairline py-2 last:border-0">
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">{one.fullName}</span>
                        <span className="text-kumo-subtle">
                          {t(`relation${one.relation}`)} · {t("dependentSince", { month: format.dateTime(dayOnly(one.fromMonth), { month: "2-digit", year: "numeric" }) })}
                        </span>
                      </span>
                      <StatePill tone={DEPENDENT_TONE[one.state]}>{t(`dependentState${one.state}`)}</StatePill>
                    </li>
                  ))}
                </ul>
              )}
            </AsideCard>
          </>
        }
      >
        <div className="flex flex-col gap-6">
          <LayerCard>
            <CardHead
              title={t("todayTitle")}
              action={
                <span className="font-normal text-kumo-subtle">
                  {format.dateTime(dayOnly(today), { weekday: "long", day: "numeric", month: "long" })}
                </span>
              }
            />
            <LayerCard.Primary>
              <div className="grid gap-6 sm:grid-cols-2">
                <TodayPart label={t("todayShift")}>
                  {roster.isPending ? <Waiting /> : roster.isError ? <Failed onRetry={() => void roster.refetch()} /> : shiftToday}
                </TodayPart>
                <TodayPart label={t("todayPunches")}>
                  {punches.isPending ? (
                    <Waiting />
                  ) : punches.isError ? (
                    <Failed onRetry={() => void punches.refetch()} />
                  ) : punches.data.length === 0 ? (
                    <p className="text-kumo-subtle">{t("noPunchToday")}</p>
                  ) : (
                    <ul className="flex flex-wrap gap-x-4 gap-y-1">
                      {punches.data.map((one) => (
                        <li key={one.id} className="flex items-baseline gap-1.5">
                          <span className="text-lg font-semibold tabular-nums">{clock(one.ts)}</span>
                          <span className="text-kumo-subtle">{a(`direction${one.direction}`)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </TodayPart>
              </div>
              <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-kumo-hairline pt-3">
                <Link href="/me/attendance" className="text-kumo-link hover:underline">
                  {t("allPunches")}
                </Link>
                <Link href={`/me/requests?new=ATTENDANCE_FIX&date=${today}`} className="text-kumo-link hover:underline">
                  {t("fixToday")}
                </Link>
              </div>
            </LayerCard.Primary>
          </LayerCard>

          <LayerCard>
            <CardHead
              title={t("leaveLeft")}
              action={
                <Input
                  size="sm"
                  type="date"
                  aria-label={t("asOf")}
                  title={t("asOf")}
                  value={asOf}
                  onChange={(event) => setAsOf(event.target.value || today)}
                  className="w-40"
                />
              }
            />
            <LayerCard.Primary>
              {balances.isPending ? (
                <Waiting />
              ) : balances.isError ? (
                <Failed onRetry={() => void balances.refetch()} />
              ) : balances.data.length === 0 ? (
                <p className="text-kumo-subtle">{r("balancesEmpty")}</p>
              ) : (
                <Facts
                  rows={balances.data.map((one) => [
                    one.name,
                    <span key={one.leaveTypeId} className="flex flex-col items-end">
                      <span className="text-lg font-semibold tabular-nums">{days(one.remaining, locale)}</span>
                      {one.bookedAfter > 0 ? (
                        <span className="text-sm text-kumo-warning">{t("bookedAfter", { days: one.bookedAfter })}</span>
                      ) : null}
                    </span>,
                  ])}
                />
              )}
            </LayerCard.Primary>
          </LayerCard>

          <LayerCard>
            <CardHead
              title={t("pendingRequests")}
              action={
                <Link href="/me/requests" className="font-normal text-kumo-link hover:underline">
                  {common("seeAll")}
                </Link>
              }
            />
            <LayerCard.Primary>
              {requests.isPending ? (
                <Waiting />
              ) : requests.isError ? (
                <Failed onRetry={() => void requests.refetch()} />
              ) : pending.length === 0 ? (
                <Empty
                  size="sm"
                  icon={<TrayIcon size={32} className="text-kumo-inactive" />}
                  title={t("noPending")}
                  description={t("noPendingHint")}
                />
              ) : (
                <ul className="-my-1 flex flex-col">
                  {pending.map((row) => (
                    <li key={row.id}>
                      <Link
                        href="/me/requests"
                        className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-kumo-tint"
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">
                            {r(`kind${row.kind}`)}
                            {row.leaveType ? ` · ${row.leaveType.name}` : ""}
                          </span>
                          <span className="text-kumo-subtle tabular-nums">
                            {format.dateTime(dayOnly(row.fromDate), "day")}
                            {row.toDate !== row.fromDate ? ` → ${format.dateTime(dayOnly(row.toDate), "day")}` : ""}
                            {Number(row.days) > 0 ? ` · ${days(Number(row.days), locale)}` : ""}
                          </span>
                        </span>
                        <StatePill tone="waiting" className="shrink-0 tabular-nums">
                          {waited(row.createdAt) > 0 ? r("waited", { count: waited(row.createdAt) }) : r("statePENDING")}
                        </StatePill>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </LayerCard.Primary>
          </LayerCard>

          <LayerCard>
            <CardHead
              title={t("latestPayslip")}
              action={
                latest.data ? (
                  <Link href={`/me/payslips?slip=${latest.data.id}`} className="font-normal text-kumo-link hover:underline">
                    {t("openPayslip")}
                  </Link>
                ) : undefined
              }
            />
            <LayerCard.Primary>
              {latest.isPending ? (
                <Waiting />
              ) : latest.isError ? (
                <Failed onRetry={() => void latest.refetch()} />
              ) : latest.data === null ? (
                <Empty
                  size="sm"
                  icon={<ReceiptIcon size={32} className="text-kumo-inactive" />}
                  title={pay("empty")}
                  description={t("noPayslipHint")}
                />
              ) : (
                <Facts
                  rows={[
                    [
                      pay("period"),
                      latest.data.period
                        ? `${String(latest.data.period.month).padStart(2, "0")}/${latest.data.period.year}`
                        : common("empty"),
                    ],
                    [
                      pay("net"),
                      <span key="net" className="text-lg font-semibold tabular-nums">
                        {money(Number(latest.data.netPay), locale)}
                      </span>,
                    ],
                  ]}
                />
              )}
            </LayerCard.Primary>
          </LayerCard>
        </div>
      </PageLayout>

      <RequestForm key={seed} open={filing} onOpenChange={setFiling} kind="LEAVE" />

      <LayerDialog.Root open={declaring} onOpenChange={setDeclaring} dismissDisabled={addDependent.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("dependentAdd")}</LayerDialog.Title>
          <LayerDialog.Description>{t("dependentsLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <form
              id={kDependentForm}
              className="flex flex-col gap-4"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                setFault(null);
                addDependent.mutate();
              }}
            >
              <Input
                label={t("dependentName")}
                required
                maxLength={120}
                value={dependentName}
                onChange={(event) => setDependentName(event.target.value)}
              />
              <Select
                label={t("dependentRelation")}
                hideLabel={false}
                className="w-full"
                value={relation}
                onValueChange={(next) => setRelation(String(next ?? "CHILD") as Relation)}
                items={Object.fromEntries(RELATIONS.map((one) => [one, t(`relation${one}`)]))}
              />
              <div className="flex flex-col gap-1.5">
                <Label>{t("dependentFrom")}</Label>
                <MonthPicker value={fromMonth} onChange={setFromMonth} />
              </div>
              {fault ? <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null}
            </form>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary type="submit" form={kDependentForm} loading={addDependent.isPending}>
              {t("dependentSend")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}
