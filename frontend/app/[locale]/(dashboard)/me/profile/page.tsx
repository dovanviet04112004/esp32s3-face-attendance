"use client";

import { Banner, Button, Empty, Input, Label, LayerCard, LayerDialog, Select } from "@cloudflare/kumo";
import { InfoIcon, PencilSimpleIcon, PlusIcon, UsersThreeIcon, WarningCircleIcon, XCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { Suspense, useState, type FormEvent } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { DateField } from "@/components/ui/date-field";
import { Failed } from "@/components/ui/failed";
import { MonthPicker, thisMonth, type Month } from "@/components/ui/month-picker";
import { useNotify } from "@/components/ui/notify";
import { useOptional } from "@/components/ui/optional";
import { PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill, type Tone } from "@/components/ui/pill";
import { SkeletonLine } from "@/components/ui/skeleton";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { dayOnly } from "@/lib/format";

const FIELDS = {
  PERSONAL_EMAIL: [{ column: "personalEmail", type: "email", max: 128 }],
  PHONE: [{ column: "phone", type: "tel", max: 20 }],
  BANK: [
    { column: "bankName", type: "text", max: 64 },
    { column: "bankAccount", type: "text", max: 32 },
  ],
  NATIONAL_ID: [{ column: "nationalId", type: "text", max: 20 }],
  TAX_CODE: [{ column: "taxCode", type: "text", max: 20 }],
  SOCIAL_INSURANCE_NO: [{ column: "socialInsuranceNo", type: "text", max: 20 }],
} as const;

type FieldName = keyof typeof FIELDS;
type ProfileColumn = (typeof FIELDS)[FieldName][number]["column"];
type ChangeState = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

const FIELD_NAMES = Object.keys(FIELDS) as FieldName[];
const kHere = "/me/profile";
const kAskForm = "profile-form";
const kDependentForm = "dependent-form";
const kNameMax = 120;
const kIdMax = 32;
const RELATIONS = ["CHILD", "SPOUSE", "PARENT", "SIBLING", "OTHER"] as const;

type Relation = (typeof RELATIONS)[number];
type DependentState = "PENDING" | "ACTIVE" | "REJECTED" | "ENDED";

interface Dependent {
  id: string;
  fullName: string;
  relation: Relation;
  fromMonth: string;
  toMonth: string | null;
  state: DependentState;
  decisionNote: string | null;
}

const DEPENDENT_TONE: Record<DependentState, Tone> = {
  PENDING: "waiting",
  ACTIVE: "good",
  REJECTED: "bad",
  ENDED: "idle",
};

function monthStart(at: Month): string {
  return `${at.year}-${String(at.month).padStart(2, "0")}-01`;
}

const CHANGE_TONE: Record<ChangeState, Tone> = {
  PENDING: "waiting",
  APPROVED: "good",
  REJECTED: "bad",
  CANCELLED: "idle",
};

interface Change {
  id: string;
  employeeId: number;
  field: FieldName;
  state: ChangeState;
  oldValue: Record<string, string | null> | null;
  newValue: Record<string, string | null>;
  noticeTo: string | null;
  reason: string | null;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
}

type Me = Partial<Record<ProfileColumn, string | null>>;

function reads(values: Record<string, string | null> | null, blank: string): string {
  const shown = Object.values(values ?? {}).filter((one) => one !== null && one !== "");
  return shown.length > 0 ? shown.join(" · ") : blank;
}

function isField(value: string | null): value is FieldName {
  return value !== null && (FIELD_NAMES as string[]).includes(value);
}

/** The people this person claims for tax relief, and the way to claim one more (KEHOACH 9.7). */
function Dependents({ employeeId }: { employeeId: number }) {
  const t = useTranslations("me");
  const common = useTranslations("common");
  const format = useFormatter();
  const optional = useOptional();
  const faultOf = useFault();
  const notify = useNotify();
  const cache = useQueryClient();
  const [declaring, setDeclaring] = useState(false);
  const [name, setName] = useState("");
  const [relation, setRelation] = useState<Relation>("CHILD");
  const [born, setBorn] = useState("");
  const [taxCode, setTaxCode] = useState("");
  const [fromMonth, setFromMonth] = useState<Month>(thisMonth());
  const [fault, setFault] = useState<string | null>(null);

  const dependents = useQuery({
    queryKey: ["dependents", employeeId],
    queryFn: async () => (await api.get<Dependent[]>(`/employees/${employeeId}/dependents`)).data,
  });

  const declare = useMutation({
    mutationFn: () =>
      api.post("/dependents", {
        fullName: name.trim(),
        relation,
        fromMonth: monthStart(fromMonth),
        ...(born ? { dateOfBirth: born } : {}),
        ...(taxCode.trim() ? { taxCode: taxCode.trim() } : {}),
      }),
    onSuccess: () => {
      notify.done(t("dependentAdded"));
      setDeclaring(false);
      void cache.invalidateQueries({ queryKey: ["dependents"] });
      void cache.invalidateQueries({ queryKey: ["tax-year"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function open(): void {
    setName("");
    setRelation("CHILD");
    setBorn("");
    setTaxCode("");
    setFromMonth(thisMonth());
    setFault(null);
    setDeclaring(true);
  }

  const rows = dependents.data ?? [];

  return (
    <>
      <LayerCard className="mt-6">
        <LayerCard.Secondary className="justify-between">
          <span>{t("dependentsTitle")}</span>
          {rows.length > 0 ? (
            <Button variant="ghost" size="sm" icon={PlusIcon} onClick={open}>
              {t("dependentAddShort")}
            </Button>
          ) : null}
        </LayerCard.Secondary>
        <LayerCard.Primary>
          {dependents.isPending ? (
            <div className="flex flex-col gap-2">
              <SkeletonLine minWidth={25} maxWidth={45} />
              <SkeletonLine minWidth={25} maxWidth={40} />
            </div>
          ) : dependents.isError ? (
            <Failed onRetry={() => void dependents.refetch()} />
          ) : rows.length === 0 ? (
            <Empty
              size="sm"
              icon={<UsersThreeIcon size={32} className="text-kumo-inactive" />}
              title={t("dependentsEmpty")}
              description={t("dependentsEmptyHint")}
              contents={
                <Button variant="secondary" icon={PlusIcon} onClick={open}>
                  {t("dependentAdd")}
                </Button>
              }
            />
          ) : (
            <ul className="-my-1 flex flex-col">
              {rows.map((one) => (
                <li key={one.id} className="flex items-center justify-between gap-3 border-b border-kumo-hairline py-2 last:border-0">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{one.fullName}</span>
                    <span className="text-kumo-subtle">
                      {t(`relation${one.relation}`)} ·{" "}
                      {t("dependentSince", { month: format.dateTime(dayOnly(one.fromMonth), { month: "2-digit", year: "numeric" }) })}
                    </span>
                    {one.state === "REJECTED" && one.decisionNote ? <span className="text-kumo-danger">{one.decisionNote}</span> : null}
                  </span>
                  <StatePill tone={DEPENDENT_TONE[one.state]}>{t(`dependentState${one.state}`)}</StatePill>
                </li>
              ))}
            </ul>
          )}
        </LayerCard.Primary>
      </LayerCard>

      <LayerDialog.Root open={declaring} onOpenChange={setDeclaring} dismissDisabled={declare.isPending}>
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
                declare.mutate();
              }}
            >
              <Input label={t("dependentName")} required maxLength={kNameMax} value={name} onChange={(event) => setName(event.target.value)} />
              <Select
                label={t("dependentRelation")}
                hideLabel={false}
                className="w-full"
                value={relation}
                onValueChange={(next) => setRelation(String(next ?? "CHILD") as Relation)}
                items={Object.fromEntries(RELATIONS.map((one) => [one, t(`relation${one}`)]))}
              />
              <DateField label={t("dependentBorn")} required={false} value={born} onChange={setBorn} />
              <Input
                label={optional(t("dependentTaxCode"))}
                maxLength={kIdMax}
                value={taxCode}
                onChange={(event) => setTaxCode(event.target.value)}
              />
              <div className="flex flex-col gap-1.5">
                <Label>{t("dependentFrom")}</Label>
                <MonthPicker value={fromMonth} onChange={setFromMonth} />
              </div>
              {fault ? <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null}
            </form>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary type="submit" form={kDependentForm} loading={declare.isPending}>
              {t("dependentSend")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}

function MyProfile() {
  const t = useTranslations("profile");
  const common = useTranslations("common");
  const format = useFormatter();
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();
  const router = useRouter();
  const search = useSearchParams();
  const employeeId = useSession((s) => s.employeeId);

  const askedField = search.get("field");
  const linked = search.get("new") !== null || isField(askedField);
  const [asking, setAsking] = useState(false);
  const [field, setField] = useState<FieldName>(isField(askedField) ? askedField : "BANK");
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<Change | null>(null);

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
        ...Object.fromEntries(FIELDS[field].map((one) => [one.column, typed[one.column] ?? ""])),
        ...(reason === "" ? {} : { reason }),
      }),
    onSuccess: () => {
      notify.done(t("asked"));
      closeAsk();
      void cache.invalidateQueries({ queryKey: ["profile-changes"] });
    },
    onError: (fell: unknown) => setRefused(faultOf(fell)),
  });

  const cancel = useMutation({
    mutationFn: async (id: string) => api.post(`/profile-changes/${id}/cancel`, {}),
    onSuccess: () => {
      notify.done(t("cancelled"));
      setCancelling(null);
      void cache.invalidateQueries({ queryKey: ["profile-changes"] });
    },
    onError: (fell: unknown) => {
      notify.failed(fell);
      setCancelling(null);
    },
  });

  function openAsk(): void {
    setField("BANK");
    setTyped({});
    setReason("");
    setRefused(null);
    setAsking(true);
  }

  function closeAsk(): void {
    setAsking(false);
    if (linked) {
      router.replace(kHere, { scroll: false });
    }
  }

  const held = me.data
    ? reads(Object.fromEntries(FIELDS[field].map((one) => [one.column, me.data[one.column] ?? null])), t("blank"))
    : null;

  const columns: Column<Change>[] = [
    {
      id: "field",
      header: t("field"),
      sortBy: (row) => row.field,
      cell: (row) => <span className="font-medium">{t(`field${row.field}`)}</span>,
    },
    {
      id: "change",
      header: t("change"),
      cell: (row) => (
        <span className="flex flex-col">
          <span className="break-words">
            <span className="text-kumo-subtle">{reads(row.oldValue, t("blank"))}</span>
            {" → "}
            <span className="tabular-nums">{reads(row.newValue, t("blank"))}</span>
          </span>
          {row.noticeTo ? (
            <span className="text-kumo-subtle">
              {t("noticeTo")}: {row.noticeTo}
            </span>
          ) : null}
          {row.note ? <span className="text-kumo-danger">{row.note}</span> : null}
        </span>
      ),
    },
    {
      id: "askedOn",
      header: t("askedOn"),
      sortBy: (row) => row.createdAt,
      cell: (row) => <span className="tabular-nums">{format.dateTime(new Date(row.createdAt), "day")}</span>,
    },
    {
      id: "state",
      header: t("state"),
      sortBy: (row) => row.state,
      cell: (row) => <StatePill tone={CHANGE_TONE[row.state]}>{t(`state${row.state}`)}</StatePill>,
    },
  ];

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("lead")}
        actions={
          <Button variant="primary" icon={PencilSimpleIcon} onClick={openAsk}>
            {t("ask")}
          </Button>
        }
      />

      <PageLayout>
        <DataTable
          id="my-profile-changes"
          cardLead="field"
          columns={columns}
          rows={changes.data}
          keyOf={(row) => row.id}
          pending={changes.isPending}
          failed={changes.isError}
          onRetry={() => void changes.refetch()}
          empty={t("empty")}
          emptyHint={t("emptyHint")}
          emptyAction={
            <Button variant="primary" icon={PencilSimpleIcon} onClick={openAsk}>
              {t("ask")}
            </Button>
          }
          rowActions={(row) =>
            row.state === "PENDING" && row.employeeId === employeeId
              ? [{ key: "cancel", label: t("cancel"), icon: XCircleIcon, danger: true, onSelect: () => setCancelling(row) }]
              : []
          }
        />
        {employeeId !== null ? <Dependents employeeId={employeeId} /> : null}
      </PageLayout>

      <LayerDialog.Root
        open={asking || linked}
        onOpenChange={(next) => (next ? setAsking(true) : closeAsk())}
        dismissDisabled={ask.isPending}
      >
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("ask")}</LayerDialog.Title>
          <LayerDialog.Description>{t("askLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <form
              id={kAskForm}
              className="flex flex-col gap-4"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                setRefused(null);
                ask.mutate();
              }}
            >
              <Select
                label={t("field")}
                hideLabel={false}
                className="w-full"
                value={field}
                description={held === null ? undefined : `${t("held")}: ${held}`}
                onValueChange={(next) => {
                  setField(String(next ?? "BANK") as FieldName);
                  setTyped({});
                }}
                items={Object.fromEntries(FIELD_NAMES.map((one) => [one, t(`field${one}`)]))}
              />
              {FIELDS[field].map((one) => (
                <Input
                  key={one.column}
                  label={t(one.column)}
                  type={one.type}
                  required
                  maxLength={one.max}
                  value={typed[one.column] ?? ""}
                  onChange={(event) => setTyped((was) => ({ ...was, [one.column]: event.target.value }))}
                />
              ))}
              <Input label={t("reason")} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
              {field === "BANK" || field === "PERSONAL_EMAIL" ? (
                <Banner size="sm" icon={<InfoIcon weight="fill" />} description={field === "BANK" ? t("bankWarning") : t("emailWarning")} />
              ) : null}
              {refused ? <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title={refused} /> : null}
            </form>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary type="submit" form={kAskForm} loading={ask.isPending}>
              {t("send")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Alert open={cancelling !== null} onOpenChange={(next) => !next && setCancelling(null)} dismissDisabled={cancel.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("cancelTitle")}</LayerDialog.Title>
          <LayerDialog.Description>
            {cancelling ? t("cancelLead", { field: t(`field${cancelling.field}`) }) : ""}
          </LayerDialog.Description>
          <LayerDialog.Body>
            {cancelling ? <p className="text-kumo-subtle">{reads(cancelling.newValue, t("blank"))}</p> : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("back")}>
            <LayerDialog.Actions.Primary
              variant="destructive"
              loading={cancel.isPending}
              onClick={() => cancelling && cancel.mutate(cancelling.id)}
            >
              {t("cancel")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </>
  );
}

// Asking straight from the employee home rides on the query string, which the prerender does not have.
export default function MyProfilePage() {
  return (
    <Suspense>
      <MyProfile />
    </Suspense>
  );
}
