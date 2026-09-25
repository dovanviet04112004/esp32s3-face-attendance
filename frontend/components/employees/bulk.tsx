"use client";

import { Banner, Button, LayerDialog } from "@cloudflare/kumo";
import { ArrowsLeftRightIcon, CalendarPlusIcon, EnvelopeSimpleIcon, ScanSmileyIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { ChoiceField, type DepartmentChoice } from "@/components/forms/employee-form";
import { DateField } from "@/components/ui/date-field";
import { useNotify } from "@/components/ui/notify";
import { PersonPicker, type Person } from "@/components/ui/person-picker";
import { CountPill } from "@/components/ui/pill";
import { SkeletonLine } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";
import { clockOf, dayOnly } from "@/lib/format";

export type BulkJob = "place" | "invite" | "kiosk" | "shift";

type SkipReason =
  | "EMPLOYEE_NOT_FOUND"
  | "EMPLOYEE_HAS_LEFT"
  | "LEAVING_SCHEDULED"
  | "UNCHANGED"
  | "DEPARTMENT_OTHER_ENTITY"
  | "MANAGER_CYCLE"
  | "NO_EMAIL"
  | "EMAIL_TAKEN"
  | "LOGIN_IN_USE"
  | "ACCOUNT_LOCKED"
  | "CONSENT_MISSING"
  | "ALREADY_ON_KIOSK"
  | "ALREADY_ON_SHIFT";

interface Skip {
  employeeId: number;
  code: string | null;
  fullName: string | null;
  reason: SkipReason;
}

interface Row {
  employeeId: number;
  code: string;
  fullName: string;
}

interface Plan<R extends Row> {
  applied: boolean;
  rows: R[];
  skipped: Skip[];
}

type Field = "jobTitle" | "department" | "manager" | "legalEntity";

interface PlaceRow extends Row {
  changes: { field: Field; from: string | null; to: string | null }[];
  pendingRequests: number;
}

interface PlacePlan extends Plan<PlaceRow> {
  requestsMoved: number;
}

interface InviteRow extends Row {
  email: string;
  resend: boolean;
}

interface Kiosk {
  id: string;
  name: string | null;
}

interface Shift {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  active: boolean;
}

type Filter = Record<string, string | number | boolean>;

/** Who a bulk run acts on: the rows ticked, or everyone the filter finds (KEHOACH 9.20). */
interface Selection {
  employeeIds?: number[];
  filter?: Filter;
}

interface Asked {
  job: BulkJob;
  selection: Selection;
  count: number;
}

interface DialogProps {
  open: boolean;
  asked: Asked;
  onClose: () => void;
  onDone: () => void;
}

// Literal keys, so a missing translation breaks the build (CLAUDE.md 3.1).
const FIELD_KEY = {
  jobTitle: "jobTitle",
  department: "department",
  manager: "manager",
  legalEntity: "legalEntity",
} as const;
const kShownRows = 50;
const kShownNames = 5;
const PHONE = "(max-width: 47.99rem)";
// A preview is asked for, never kept: the next look has to read the rows as they stand.
const FRESH_PREVIEW = { staleTime: Infinity, gcTime: 0, retry: false, refetchOnWindowFocus: false } as const;

function usePhone(): boolean {
  const listen = useCallback((again: () => void) => {
    const query = window.matchMedia(PHONE);
    query.addEventListener("change", again);
    return () => query.removeEventListener("change", again);
  }, []);
  return useSyncExternalStore(
    listen,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

function localDay(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

// The directory keeps its filter as query-string text; the api reads booleans and numbers.
function asFilter(filter: Record<string, string>): Filter {
  const kept = Object.entries(filter).filter(([, value]) => value !== "");
  return Object.fromEntries(
    kept.map(([key, value]) => [key, key === "active" ? value === "true" : key === "within" ? Number(value) : value]),
  );
}

function useSkipWords(): (reason: string) => string {
  const t = useTranslations("bulkSkips");
  return (reason) => (t.has(reason as never) ? t(reason as never) : reason);
}

/** What a bulk run would do: who changes, how, and who it passes over with the reason why. */
function Preview<R extends Row>({
  plan,
  pending,
  fault,
  waiting,
  headline,
  detail,
  extra,
}: {
  plan: Plan<R> | undefined;
  pending: boolean;
  fault: string | null;
  waiting: string | null;
  headline: string;
  detail?: (row: R) => ReactNode;
  extra?: ReactNode;
}) {
  const t = useTranslations("bulk");
  const skipWord = useSkipWords();
  if (waiting) {
    return <p className="text-kumo-subtle">{waiting}</p>;
  }
  if (fault) {
    return <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} />;
  }
  if (pending || !plan) {
    return (
      <div className="flex flex-col gap-2">
        <SkeletonLine minWidth={40} maxWidth={60} />
        <SkeletonLine minWidth={60} maxWidth={90} />
        <SkeletonLine minWidth={50} maxWidth={80} />
      </div>
    );
  }
  const groups = new Map<string, Skip[]>();
  for (const one of plan.skipped) {
    groups.set(one.reason, [...(groups.get(one.reason) ?? []), one]);
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="m-0 font-medium">{plan.rows.length > 0 ? headline : t("nobody")}</p>
        {extra}
        {plan.rows.length > 0 ? (
          <ul className="m-0 flex max-h-64 flex-col overflow-y-auto rounded-lg border border-kumo-hairline p-0">
            {plan.rows.slice(0, kShownRows).map((row) => (
              <li key={row.employeeId} className="flex flex-col gap-0.5 border-b border-kumo-hairline px-3 py-2 last:border-0">
                <span className="flex min-w-0 items-baseline gap-3">
                  <span className="min-w-0 truncate">{row.fullName}</span>
                  <span className="shrink-0 font-mono text-sm text-kumo-subtle">{row.code}</span>
                </span>
                {detail ? <span className="text-sm text-kumo-subtle">{detail(row)}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {plan.rows.length > kShownRows ? (
          <p className="m-0 text-sm text-kumo-subtle">{t("showingFirst", { shown: kShownRows })}</p>
        ) : null}
      </div>
      {plan.skipped.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="m-0 font-medium">{t("skippedTitle", { count: plan.skipped.length })}</p>
          <ul className="m-0 flex flex-col gap-2 p-0">
            {[...groups].map(([reason, people]) => (
              <li key={reason} className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  {skipWord(reason)}
                  <CountPill>{people.length}</CountPill>
                </span>
                <span className="text-sm text-kumo-subtle">
                  {people
                    .slice(0, kShownNames)
                    .map((one) => one.fullName ?? String(one.employeeId))
                    .join(", ")}
                  {people.length > kShownNames ? ` ${t("andMore", { count: people.length - kShownNames })}` : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function PlaceDialog({ open, asked, onClose, onDone }: DialogProps) {
  const t = useTranslations("bulk");
  const e = useTranslations("employees");
  const common = useTranslations("common");
  const cache = useQueryClient();
  const notify = useNotify();
  const faultOf = useFault();
  const phone = usePhone();
  const [entityId, setEntityId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [jobTitleId, setJobTitleId] = useState("");
  const [boss, setBoss] = useState<Person | null>(null);

  const departments = useQuery({
    queryKey: ["departments"],
    enabled: open,
    queryFn: async () => (await api.get<DepartmentChoice[]>("/departments")).data,
  });
  const titles = useQuery({
    queryKey: ["job-titles"],
    enabled: open,
    queryFn: async () => (await api.get<DepartmentChoice[]>("/job-titles")).data,
  });
  const entities = useQuery({
    queryKey: ["legal-entities"],
    enabled: open,
    queryFn: async () => (await api.get<DepartmentChoice[]>("/legal-entities")).data,
  });
  const ownDepartments = (departments.data ?? []).filter((one) => !entityId || one.legalEntityId === entityId);

  const body = {
    ...asked.selection,
    ...(jobTitleId ? { jobTitleId } : {}),
    ...(departmentId ? { departmentId } : {}),
    ...(boss ? { managerId: boss.id } : {}),
    ...(entityId ? { legalEntityId: entityId } : {}),
  };
  const ready = jobTitleId !== "" || departmentId !== "" || boss !== null || entityId !== "";
  const preview = useQuery({
    queryKey: ["bulk-preview", "place", body],
    enabled: open && ready && !phone,
    queryFn: async () => (await api.post<PlacePlan>("/employees/bulk/placement", body)).data,
    ...FRESH_PREVIEW,
  });
  const apply = useMutation({
    mutationFn: async () => (await api.post<PlacePlan>("/employees/bulk/placement?apply=true", body)).data,
    onSuccess: (done) => {
      notify.done(
        t("donePlace", { count: done.rows.length }),
        done.skipped.length > 0 ? t("doneSkipped", { count: done.skipped.length }) : undefined,
      );
      for (const key of ["employees", "users", "requests", "departments"]) {
        void cache.invalidateQueries({ queryKey: [key] });
      }
      onDone();
    },
    onError: notify.failed,
  });

  function pickEntity(next: string): void {
    setEntityId(next);
    const kept = departments.data?.find((one) => one.id === departmentId);
    if (kept && next && kept.legalEntityId !== next) {
      setDepartmentId("");
    }
  }

  const plan = preview.data;
  const writes = plan?.rows.length ?? 0;
  const fieldName = (field: Field) => e(FIELD_KEY[field]);
  return (
    <LayerDialog.Root open={open} onOpenChange={(next) => !next && onClose()} dismissDisabled={apply.isPending}>
      <LayerDialog.Content size="lg" closeLabel={common("close")}>
        <LayerDialog.Title>{t("placeTitle", { count: asked.count })}</LayerDialog.Title>
        <LayerDialog.Description>{phone ? t("placeDeskOnly") : t("placeLead")}</LayerDialog.Description>
        <LayerDialog.Body>
          {phone ? null : (
            <div className="flex flex-col gap-5">
              <div className="grid items-start gap-4 sm:grid-cols-2">
                <ChoiceField
                  label={e("jobTitle")}
                  items={titles.data ?? []}
                  value={jobTitleId}
                  empty={e("jobTitlesEmpty")}
                  onChange={setJobTitleId}
                />
                <ChoiceField
                  label={e("department")}
                  items={ownDepartments}
                  value={departmentId}
                  empty={e("departmentsEmpty")}
                  onChange={setDepartmentId}
                />
                <PersonPicker
                  label={e("manager")}
                  description={e("managerHint")}
                  value={boss}
                  near={departmentId || undefined}
                  onChange={setBoss}
                />
                {(entities.data?.length ?? 0) > 1 ? (
                  <ChoiceField
                    label={e("legalEntity")}
                    items={entities.data ?? []}
                    value={entityId}
                    empty={e("legalEntityPick")}
                    onChange={pickEntity}
                  />
                ) : null}
              </div>
              <Preview
                plan={plan}
                pending={preview.isFetching}
                fault={preview.isError ? faultOf(preview.error) : null}
                waiting={ready ? null : t("placePickFirst")}
                headline={t("willChange", { count: writes })}
                detail={(row) =>
                  row.changes
                    .map((one) => `${fieldName(one.field)}: ${one.from ?? common("empty")} → ${one.to ?? common("empty")}`)
                    .join(" · ")
                }
                extra={
                  plan && plan.requestsMoved > 0 ? (
                    <p className="m-0 text-kumo-subtle">{t("requestsMove", { count: plan.requestsMoved })}</p>
                  ) : null
                }
              />
            </div>
          )}
        </LayerDialog.Body>
        {phone ? null : (
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              loading={apply.isPending}
              disabled={writes === 0 || preview.isFetching}
              onClick={() => apply.mutate()}
            >
              {writes > 0 ? t("applyPlace", { count: writes }) : t("place")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        )}
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

function InviteDialog({ open, asked, onClose, onDone }: DialogProps) {
  const t = useTranslations("bulk");
  const common = useTranslations("common");
  const cache = useQueryClient();
  const notify = useNotify();
  const faultOf = useFault();

  const preview = useQuery({
    queryKey: ["bulk-preview", "invite", asked.selection],
    enabled: open,
    queryFn: async () => (await api.post<Plan<InviteRow>>("/employees/bulk/logins", asked.selection)).data,
    ...FRESH_PREVIEW,
  });
  const apply = useMutation({
    mutationFn: async () => (await api.post<Plan<InviteRow>>("/employees/bulk/logins?apply=true", asked.selection)).data,
    onSuccess: (done) => {
      notify.done(
        t("doneInvite", { count: done.rows.length }),
        done.skipped.length > 0 ? t("doneSkipped", { count: done.skipped.length }) : undefined,
      );
      void cache.invalidateQueries({ queryKey: ["employees"] });
      void cache.invalidateQueries({ queryKey: ["users"] });
      onDone();
    },
    onError: notify.failed,
  });

  const plan = preview.data;
  const resent = plan?.rows.filter((one) => one.resend).length ?? 0;
  const writes = plan?.rows.length ?? 0;
  return (
    <LayerDialog.Root open={open} onOpenChange={(next) => !next && onClose()} dismissDisabled={apply.isPending}>
      <LayerDialog.Content size="lg" closeLabel={common("close")}>
        <LayerDialog.Title>{t("inviteTitle", { count: asked.count })}</LayerDialog.Title>
        <LayerDialog.Description>{t("inviteLead")}</LayerDialog.Description>
        <LayerDialog.Body>
          <Preview
            plan={plan}
            pending={preview.isFetching}
            fault={preview.isError ? faultOf(preview.error) : null}
            waiting={null}
            headline={[
              writes > resent ? t("willOpen", { count: writes - resent }) : "",
              resent > 0 ? t("willResend", { count: resent }) : "",
            ]
              .filter(Boolean)
              .join(" · ")}
            detail={(row) => `${row.email} · ${row.resend ? t("resends") : t("opens")}`}
          />
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel={common("cancel")}>
          <LayerDialog.Actions.Primary
            loading={apply.isPending}
            disabled={writes === 0 || preview.isFetching}
            onClick={() => apply.mutate()}
          >
            {writes > 0 ? t("applyInvite", { count: writes }) : t("invite")}
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

function KioskDialog({ open, asked, onClose, onDone }: DialogProps) {
  const t = useTranslations("bulk");
  const common = useTranslations("common");
  const cache = useQueryClient();
  const notify = useNotify();
  const faultOf = useFault();
  const [deviceId, setDeviceId] = useState("");

  const devices = useQuery({
    queryKey: ["enrollments", "devices"],
    enabled: open,
    queryFn: async () => (await api.get<Kiosk[]>("/enrollments/devices")).data,
  });
  const choices: DepartmentChoice[] = (devices.data ?? []).map((one) => ({ id: one.id, code: one.id, name: one.name ?? one.id }));
  const kioskName = choices.find((one) => one.id === deviceId)?.name ?? deviceId;

  const body = { ...asked.selection, deviceId };
  const preview = useQuery({
    queryKey: ["bulk-preview", "kiosk", body],
    enabled: open && deviceId !== "",
    queryFn: async () => (await api.post<Plan<Row>>("/employees/bulk/enrollments", body)).data,
    ...FRESH_PREVIEW,
  });
  const apply = useMutation({
    mutationFn: async () => (await api.post<Plan<Row>>("/employees/bulk/enrollments?apply=true", body)).data,
    onSuccess: (done) => {
      notify.done(
        t("doneKiosk", { count: done.rows.length, kiosk: kioskName }),
        done.skipped.length > 0 ? t("doneSkipped", { count: done.skipped.length }) : undefined,
      );
      void cache.invalidateQueries({ queryKey: ["enrollments"] });
      void cache.invalidateQueries({ queryKey: ["devices"] });
      onDone();
    },
    onError: notify.failed,
  });

  const writes = preview.data?.rows.length ?? 0;
  return (
    <LayerDialog.Root open={open} onOpenChange={(next) => !next && onClose()} dismissDisabled={apply.isPending}>
      <LayerDialog.Content size="lg" closeLabel={common("close")}>
        <LayerDialog.Title>{t("kioskTitle", { count: asked.count })}</LayerDialog.Title>
        <LayerDialog.Description>{t("kioskLead")}</LayerDialog.Description>
        <LayerDialog.Body>
          <div className="flex flex-col gap-5">
            <ChoiceField label={t("kioskPick")} items={choices} value={deviceId} empty={t("kioskNone")} onChange={setDeviceId} />
            <Preview
              plan={preview.data}
              pending={preview.isFetching}
              fault={preview.isError ? faultOf(preview.error) : null}
              waiting={deviceId ? null : t("kioskPickFirst")}
              headline={t("willKiosk", { count: writes, kiosk: kioskName })}
            />
          </div>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel={common("cancel")}>
          <LayerDialog.Actions.Primary
            loading={apply.isPending}
            disabled={writes === 0 || preview.isFetching}
            onClick={() => apply.mutate()}
          >
            {writes > 0 ? t("applyKiosk", { count: writes }) : t("kiosk")}
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

function ShiftDialog({ open, asked, onClose, onDone }: DialogProps) {
  const t = useTranslations("bulk");
  const s = useTranslations("shifts");
  const e = useTranslations("employees");
  const common = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();
  const cache = useQueryClient();
  const notify = useNotify();
  const faultOf = useFault();
  const [shiftId, setShiftId] = useState("");
  const [validFrom, setValidFrom] = useState(() => localDay(new Date()));
  const [validTo, setValidTo] = useState("");

  const shifts = useQuery({
    queryKey: ["shifts"],
    enabled: open,
    queryFn: async () => (await api.get<Shift[]>("/shifts")).data,
  });
  const choices: DepartmentChoice[] = (shifts.data ?? [])
    .filter((one) => one.active)
    .map((one) => ({ id: one.id, code: `${clockOf(one.startTime, locale)} – ${clockOf(one.endTime, locale)}`, name: one.name }));
  const shiftName = choices.find((one) => one.id === shiftId)?.name ?? "";

  const body = {
    ...asked.selection,
    validFrom: validFrom ? new Date(`${validFrom}T00:00:00.000Z`).toISOString() : "",
    ...(validTo ? { validTo: new Date(`${validTo}T00:00:00.000Z`).toISOString() } : {}),
  };
  const ready = shiftId !== "" && validFrom !== "";
  const preview = useQuery({
    queryKey: ["bulk-preview", "shift", shiftId, body],
    enabled: open && ready,
    queryFn: async () => (await api.post<Plan<Row>>(`/shifts/${shiftId}/assignments/bulk`, body)).data,
    ...FRESH_PREVIEW,
  });
  const apply = useMutation({
    mutationFn: async () => (await api.post<Plan<Row>>(`/shifts/${shiftId}/assignments/bulk?apply=true`, body)).data,
    onSuccess: (done) => {
      notify.done(
        t("doneShift", { count: done.rows.length, shift: shiftName }),
        done.skipped.length > 0 ? t("doneSkipped", { count: done.skipped.length }) : undefined,
      );
      void cache.invalidateQueries({ queryKey: ["shifts"] });
      void cache.invalidateQueries({ queryKey: ["me"] });
      onDone();
    },
    onError: notify.failed,
  });

  const writes = preview.data?.rows.length ?? 0;
  return (
    <LayerDialog.Root open={open} onOpenChange={(next) => !next && onClose()} dismissDisabled={apply.isPending}>
      <LayerDialog.Content size="lg" closeLabel={common("close")}>
        <LayerDialog.Title>{t("shiftTitle", { count: asked.count })}</LayerDialog.Title>
        <LayerDialog.Description>{t("shiftLead")}</LayerDialog.Description>
        <LayerDialog.Body>
          <div className="flex flex-col gap-5">
            <ChoiceField label={e("shiftPick")} items={choices} value={shiftId} empty={t("shiftNone")} onChange={setShiftId} />
            <div className="grid items-start gap-4 sm:grid-cols-2">
              <DateField
                label={s("validFrom")}
                value={validFrom}
                error={validFrom === "" ? common("required") : undefined}
                onChange={setValidFrom}
              />
              <DateField
                label={s("validTo")}
                required={false}
                min={validFrom || undefined}
                value={validTo}
                description={s("validToHint")}
                onChange={setValidTo}
              />
            </div>
            <Preview
              plan={preview.data}
              pending={preview.isFetching}
              fault={preview.isError ? faultOf(preview.error) : null}
              waiting={ready ? null : t("shiftPickFirst")}
              headline={t("willShift", {
                count: writes,
                shift: shiftName,
                day: validFrom ? format.dateTime(dayOnly(validFrom), "day") : "",
              })}
            />
          </div>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel={common("cancel")}>
          <LayerDialog.Actions.Primary
            loading={apply.isPending}
            disabled={writes === 0 || preview.isFetching}
            onClick={() => apply.mutate()}
          >
            {writes > 0 ? t("applyShift", { count: writes }) : t("shift")}
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

const DIALOGS: Record<BulkJob, (props: DialogProps) => ReactNode> = {
  place: PlaceDialog,
  invite: InviteDialog,
  kiosk: KioskDialog,
  shift: ShiftDialog,
};

/** The props DataTable takes to tick rows and act on them. */
export interface TableSelection<T> {
  selectable?: boolean;
  chosen?: ReadonlySet<string>;
  onChosenChange?: (next: ReadonlySet<string>) => void;
  chosenLabel?: string;
  bulk?: (picked: T[]) => ReactNode;
}

/** The directory's selection and the four things it does to it (KEHOACH 9.20): rows ticked one
 *  by one, or, once every loaded row is ticked, everyone the filter finds, resolved by the server.
 */
export function useDirectorySelection<T extends { id: number }>({
  filter,
  total,
  exact,
  loaded,
  enabled,
}: {
  filter: Record<string, string>;
  total: number | undefined;
  exact: boolean | undefined;
  loaded: number;
  enabled: boolean;
}): { table: TableSelection<T>; dialog: ReactNode } {
  const t = useTranslations("bulk");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [whole, setWhole] = useState(false);
  const [asked, setAsked] = useState<Asked | null>(null);
  const [openJob, setOpenJob] = useState<BulkJob | null>(null);
  const [round, setRound] = useState(0);
  const filterKey = JSON.stringify(filter);

  useEffect(() => {
    setChosen(new Set());
    setWhole(false);
  }, [filterKey]);

  const everyLoaded = loaded > 0 && chosen.size >= loaded;
  const wholeOn = whole && everyLoaded && total !== undefined;

  function start(job: BulkJob, picked: T[]): void {
    setAsked({
      job,
      count: wholeOn ? (total ?? picked.length) : picked.length,
      selection: wholeOn ? { filter: asFilter(filter) } : { employeeIds: picked.map((row) => row.id) },
    });
    setRound(round + 1);
    setOpenJob(job);
  }

  function done(): void {
    setOpenJob(null);
    setChosen(new Set());
    setWhole(false);
  }

  const table: TableSelection<T> = enabled
    ? {
        selectable: true,
        chosen,
        onChosenChange: (next) => {
          setChosen(next);
          setWhole(false);
        },
        chosenLabel: wholeOn ? t("wholeChosen", { count: total ?? 0 }) : undefined,
        bulk: (picked) => (
          <>
            <div className="grid grid-cols-2 gap-2 max-md:order-2 max-md:basis-full md:flex md:flex-wrap">
              <Button variant="secondary" size="sm" className="max-md:w-full" icon={ArrowsLeftRightIcon} onClick={() => start("place", picked)}>
                {t("place")}
              </Button>
              <Button variant="secondary" size="sm" className="max-md:w-full" icon={EnvelopeSimpleIcon} onClick={() => start("invite", picked)}>
                {t("invite")}
              </Button>
              <Button variant="secondary" size="sm" className="max-md:w-full" icon={ScanSmileyIcon} onClick={() => start("kiosk", picked)}>
                {t("kiosk")}
              </Button>
              <Button variant="secondary" size="sm" className="max-md:w-full" icon={CalendarPlusIcon} onClick={() => start("shift", picked)}>
                {t("shift")}
              </Button>
            </div>
            {everyLoaded && !wholeOn && exact !== false && total !== undefined && total > picked.length ? (
              <span className="order-last basis-full max-md:order-1">
                <Button variant="ghost" size="sm" className="text-kumo-link" onClick={() => setWhole(true)}>
                  {t("chooseWhole", { count: total })}
                </Button>
              </span>
            ) : null}
          </>
        ),
      }
    : {};

  const Dialog = asked ? DIALOGS[asked.job] : null;
  return {
    table,
    dialog:
      Dialog && asked ? (
        <Dialog key={round} open={openJob === asked.job} asked={asked} onClose={() => setOpenJob(null)} onDone={done} />
      ) : null,
  };
}
