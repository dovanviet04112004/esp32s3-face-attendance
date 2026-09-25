"use client";

import { Banner, Button, Input, LayerDialog, Select } from "@cloudflare/kumo";
import { InfoIcon, PencilSimpleIcon, WarningCircleIcon, XCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Suspense, useState, type FormEvent } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill, type Tone } from "@/components/ui/pill";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { days } from "@/lib/format";

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
const kDayMs = 86_400_000;

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

/** Days from asking to a decision, over this person's own decided asks. */
function usualWait(rows: Change[]): number | null {
  const waits = rows
    .filter((one) => one.decidedAt && (one.state === "APPROVED" || one.state === "REJECTED"))
    .map((one) => (new Date(one.decidedAt ?? one.createdAt).getTime() - new Date(one.createdAt).getTime()) / kDayMs);
  return waits.length === 0 ? null : Math.max(0, Math.round(waits.reduce((sum, one) => sum + one, 0) / waits.length));
}

function MyProfile() {
  const t = useTranslations("profile");
  const common = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();
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

  const wait = usualWait(changes.data ?? []);

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

      <PageLayout
        aside={
          <AsideCard title={t("howTitle")}>
            <Facts
              rows={[
                [t("whoDecides"), t("hrDecides")],
                [t("howLong"), wait === null ? t("noHistory") : t("usualWait", { days: days(wait, locale) })],
                [t("takesEffect"), t("takesEffectHint")],
              ]}
            />
          </AsideCard>
        }
        extra={
          <AsideCard title={common("goodToKnow")}>
            <p className="flex gap-2">
              <InfoIcon size={18} className="mt-0.5 shrink-0 text-kumo-info" aria-hidden />
              <span>{t("bankWarning")}</span>
            </p>
          </AsideCard>
        }
      >
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
