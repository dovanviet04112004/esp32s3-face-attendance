"use client";

import { Banner, Button, Combobox, Input, LayerCard, Select } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { useLocale, useTranslations } from "next-intl";
import { useRef, useState, type FormEvent, type ReactNode } from "react";

import { BottomBar } from "@/components/ui/bottom-bar";
import { DateField } from "@/components/ui/date-field";
import { useOptional } from "@/components/ui/optional";
import { PersonPicker, type Person } from "@/components/ui/person-picker";
import { cn } from "@/lib/cn";
import { money } from "@/lib/format";

export interface EmployeeDraft {
  code: string;
  fullName: string;
  legalEntityId: string;
  departmentId: string;
  jobTitleId: string;
  managerId: string;
  personalEmail: string;
  phone: string;
  hireDate: string;
  dateOfBirth: string;
  gender: "" | "MALE" | "FEMALE";
  nationalId: string;
  taxCode: string;
  socialInsuranceNo: string;
  bankAccount: string;
  bankName: string;
  contractKind: ContractKind;
  probationEnd: string;
  contractEnd: string;
  baseSalary: string;
  insuranceSalary: string;
}

export type ContractKind = "PROBATION" | "FIXED_TERM" | "INDEFINITE" | "SEASONAL" | "INTERNSHIP";

const KINDS: ContractKind[] = ["PROBATION", "FIXED_TERM", "INDEFINITE", "SEASONAL", "INTERNSHIP"];

// Literal keys, not a built string: a missing translation has to break the build (CLAUDE.md 3.1).
const KIND_KEY = {
  PROBATION: "kindPROBATION",
  FIXED_TERM: "kindFIXED_TERM",
  INDEFINITE: "kindINDEFINITE",
  SEASONAL: "kindSEASONAL",
  INTERNSHIP: "kindINTERNSHIP",
} as const;

// The longest value CreateEmployeeDto takes for each field (EMPLOYEE_FIELD_MAX in the backend).
const MAX = {
  code: 32,
  fullName: 64,
  personalEmail: 128,
  phone: 20,
  nationalId: 20,
  taxCode: 20,
  socialInsuranceNo: 20,
  bankAccount: 32,
  bankName: 64,
} as const;

/** One entry of a catalogue the form picks from; a department names its legal entity. */
export interface DepartmentChoice {
  id: string;
  code: string;
  name: string;
  legalEntityId?: string;
}

export const EMPTY_DRAFT: EmployeeDraft = {
  code: "",
  fullName: "",
  legalEntityId: "",
  departmentId: "",
  jobTitleId: "",
  managerId: "",
  personalEmail: "",
  phone: "",
  hireDate: "",
  dateOfBirth: "",
  gender: "",
  nationalId: "",
  taxCode: "",
  socialInsuranceNo: "",
  bankAccount: "",
  bankName: "",
  contractKind: "PROBATION",
  probationEnd: "",
  contractEnd: "",
  baseSalary: "",
  insuranceSalary: "",
};

interface Props {
  start: EmployeeDraft;
  departments: DepartmentChoice[];
  jobTitles: DepartmentChoice[];
  entities: DepartmentChoice[];
  /** UpdateEmployeeDto leaves bank details out: they move through an approved ProfileChange (KEHOACH 9.17 item 6). */
  showBank: boolean;
  /** An edit takes the personal email as read-only: changing it is a request with a notice (KEHOACH 9.17 item 6). */
  lockEmail?: boolean;
  showManager: boolean;
  /** The manager already on the record, so an edit form opens showing them. */
  manager?: Person | null;
  /** Taking somebody on writes five things at once (KEHOACH 9.14), starting from the hire date asked here. */
  showOnboard: boolean;
  busy: boolean;
  fault: string | null;
  onSubmit: (draft: EmployeeDraft) => void;
  /** Leaves the form; without it Cancel restores the record the form opened with. */
  onCancel?: () => void;
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

/** A catalogue long enough to need a search box: departments, job titles (KEHOACH 9.12). */
export function ChoiceField({
  label,
  description,
  items,
  value,
  empty,
  onChange,
}: {
  label: ReactNode;
  description?: string;
  items: DepartmentChoice[];
  value: string;
  /** What the open list says when the catalogue itself has nothing yet. */
  empty: string;
  onChange: (next: string) => void;
}) {
  const common = useTranslations("common");
  const held = items.find((one) => one.id === value) ?? null;
  return (
    <Combobox
      items={items}
      value={held}
      onValueChange={(next) => onChange((next as DepartmentChoice | null)?.id ?? "")}
      itemToStringLabel={(one: DepartmentChoice) => one.name}
      isItemEqualToValue={(one: DepartmentChoice, other: DepartmentChoice) => one.id === other.id}
      filter={(one: DepartmentChoice, typed: string) => fold(`${one.code} ${one.name}`).includes(fold(typed.trim()))}
      label={label}
      description={description}
    >
      <Combobox.TriggerInput placeholder={common("search")} clearLabel={common("clear")} showOptionsLabel={common("showOptions")} />
      <Combobox.Content>
        <Combobox.Empty>{items.length === 0 ? empty : common("noMatch")}</Combobox.Empty>
        <Combobox.List>
          {(one: DepartmentChoice) => (
            <Combobox.Item key={one.id} value={one}>
              <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                <span className="truncate">{one.name}</span>
                <span className="shrink-0 font-mono text-kumo-subtle">{one.code}</span>
              </span>
            </Combobox.Item>
          )}
        </Combobox.List>
      </Combobox.Content>
    </Combobox>
  );
}

/** One row of the form, Cloudflare's settings anatomy (KEHOACH 9.12): what the part is for on the left, its fields on the right. */
function Section({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <LayerCard className="grid gap-x-8 gap-y-5 p-5 @3xl:grid-cols-3 @3xl:p-6">
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-lg font-semibold text-kumo-default">{title}</h2>
        <p className="m-0 text-pretty text-kumo-subtle">{lead}</p>
      </div>
      <div className="grid min-w-0 items-start gap-x-4 gap-y-5 @lg:grid-cols-2 @3xl:col-span-2">{children}</div>
    </LayerCard>
  );
}

export function EmployeeForm({
  start,
  departments,
  jobTitles,
  entities,
  showBank,
  lockEmail = false,
  showManager,
  manager = null,
  showOnboard,
  busy,
  fault,
  onSubmit,
  onCancel,
}: Props) {
  const t = useTranslations("employees");
  const common = useTranslations("common");
  const optional = useOptional();
  const locale = useLocale();
  const entityField = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(start);
  const [boss, setBoss] = useState<Person | null>(manager);
  const [tried, setTried] = useState(false);
  const only = entities.length === 1 ? entities[0].id : "";
  const chosen = draft.legalEntityId || only;
  const choosesEntity = entities.length > 1;
  const entityMissing = choosesEntity && chosen === "";
  const dirty = JSON.stringify(draft) !== JSON.stringify(start);
  const editing = onCancel === undefined;
  // A department belongs to one legal entity, so the list follows the entity chosen above.
  const ownDepartments = departments.filter((one) => !chosen || !one.legalEntityId || one.legalEntityId === chosen);

  function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (entityMissing) {
      entityField.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      entityField.current?.querySelector("button")?.focus({ preventScroll: true });
      return;
    }
    onSubmit({ ...draft, legalEntityId: chosen });
  }

  function set(patch: Partial<EmployeeDraft>): void {
    setDraft({ ...draft, ...patch });
  }

  function pickEntity(next: string): void {
    const kept = departments.find((one) => one.id === draft.departmentId);
    set({ legalEntityId: next, departmentId: kept && kept.legalEntityId && kept.legalEntityId !== next ? "" : draft.departmentId });
  }

  function cancel(): void {
    if (onCancel) {
      onCancel();
      return;
    }
    setDraft(start);
    setBoss(manager);
  }

  const none = common("empty");
  const amount = (value: string) => (Number(value) > 0 ? money(Number(value), locale) : undefined);
  // A clean edit rests at the end of the form; anything to save rides the bottom edge.
  const pinned = !editing || dirty;

  return (
    <form onSubmit={submit} className="@container flex flex-col gap-4">
      <Section title={t("sectionWho")} lead={t("sectionWhoLead")}>
        <Input
          label={t("code")}
          required
          maxLength={MAX.code}
          value={draft.code}
          onChange={(e) => set({ code: e.target.value })}
          className="font-mono"
        />
        <Input
          label={t("fullName")}
          required
          maxLength={MAX.fullName}
          value={draft.fullName}
          onChange={(e) => set({ fullName: e.target.value })}
        />
        {choosesEntity ? (
          <div ref={entityField} className="min-w-0 scroll-mt-24">
            <Select
              label={t("legalEntity")}
              description={t("legalEntityHint")}
              error={tried && entityMissing ? t("legalEntityMissing") : undefined}
              placeholder={t("legalEntityPick")}
              value={chosen}
              onValueChange={(next) => pickEntity(String(next ?? ""))}
              items={Object.fromEntries(entities.map((one) => [one.id, one.name]))}
              className="w-full min-w-0"
            />
          </div>
        ) : null}
        <ChoiceField
          label={optional(t("department"))}
          items={ownDepartments}
          value={draft.departmentId}
          empty={t("departmentsEmpty")}
          onChange={(next) => set({ departmentId: next })}
        />
        <ChoiceField
          label={optional(t("jobTitle"))}
          items={jobTitles}
          value={draft.jobTitleId}
          empty={t("jobTitlesEmpty")}
          onChange={(next) => set({ jobTitleId: next })}
        />
        {showManager ? (
          <PersonPicker
            label={optional(t("manager"))}
            description={t("managerHint")}
            value={boss}
            near={draft.departmentId || undefined}
            onChange={(next) => {
              setBoss(next);
              set({ managerId: next ? String(next.id) : "" });
            }}
          />
        ) : null}
      </Section>

      <Section title={t("sectionReach")} lead={t("sectionReachLead")}>
        <Input
          label={lockEmail ? t("personalEmail") : optional(t("personalEmail"))}
          description={lockEmail ? t("personalEmailLocked") : t("personalEmailWhy")}
          type="email"
          maxLength={MAX.personalEmail}
          value={draft.personalEmail}
          readOnly={lockEmail}
          onChange={(e) => set({ personalEmail: e.target.value })}
        />
        <Input
          label={optional(t("phone"))}
          type="tel"
          maxLength={MAX.phone}
          value={draft.phone}
          onChange={(e) => set({ phone: e.target.value })}
        />
      </Section>

      {showOnboard ? (
        <Section title={t("sectionHire")} lead={t("sectionHireLead")}>
          <DateField
            label={t("hireDate")}
            description={t("hireStartHint")}
            required={false}
            value={draft.hireDate}
            onChange={(next) => set({ hireDate: next })}
          />
          <Select
            label={t("contractKind")}
            value={draft.contractKind}
            onValueChange={(next) => set({ contractKind: String(next ?? "PROBATION") as ContractKind })}
            items={Object.fromEntries(KINDS.map((one) => [one, t(KIND_KEY[one])]))}
            className="w-full min-w-0"
          />
          <DateField
            label={t("probationEnd")}
            required={false}
            min={draft.hireDate || undefined}
            value={draft.probationEnd}
            onChange={(next) => set({ probationEnd: next })}
          />
          <DateField
            label={t("contractEnd")}
            description={t("contractEndHint")}
            required={false}
            min={draft.hireDate || undefined}
            value={draft.contractEnd}
            onChange={(next) => set({ contractEnd: next })}
          />
          <Input
            label={optional(t("baseSalary"))}
            description={amount(draft.baseSalary)}
            type="number"
            inputMode="numeric"
            min={0}
            value={draft.baseSalary}
            onChange={(e) => set({ baseSalary: e.target.value, insuranceSalary: e.target.value })}
            className="tabular-nums"
          />
          <Input
            label={optional(t("insuranceSalary"))}
            description={amount(draft.insuranceSalary) ?? t("insuranceSalaryHint")}
            type="number"
            inputMode="numeric"
            min={0}
            value={draft.insuranceSalary}
            onChange={(e) => set({ insuranceSalary: e.target.value })}
            className="tabular-nums"
          />
        </Section>
      ) : null}

      <Section title={t("sectionFiling")} lead={t("sectionFilingLead")}>
        {showOnboard ? null : (
          <DateField
            label={t("hireDate")}
            description={t("hireDateHint")}
            required={false}
            value={draft.hireDate}
            onChange={(next) => set({ hireDate: next })}
          />
        )}
        <DateField
          label={t("dateOfBirth")}
          required={false}
          value={draft.dateOfBirth}
          onChange={(next) => set({ dateOfBirth: next })}
        />
        <Select
          label={optional(t("gender"))}
          value={draft.gender}
          onValueChange={(next) => set({ gender: String(next ?? "") as EmployeeDraft["gender"] })}
          items={{ "": none, MALE: t("genderMALE"), FEMALE: t("genderFEMALE") }}
          className="w-full min-w-0"
        />
        <Input
          label={optional(t("nationalId"))}
          maxLength={MAX.nationalId}
          value={draft.nationalId}
          onChange={(e) => set({ nationalId: e.target.value })}
          className="font-mono"
        />
        <Input
          label={optional(t("taxCode"))}
          maxLength={MAX.taxCode}
          value={draft.taxCode}
          onChange={(e) => set({ taxCode: e.target.value })}
          className="font-mono"
        />
        <Input
          label={optional(t("socialInsuranceNo"))}
          maxLength={MAX.socialInsuranceNo}
          value={draft.socialInsuranceNo}
          onChange={(e) => set({ socialInsuranceNo: e.target.value })}
          className="font-mono"
        />
      </Section>

      <Section title={t("sectionBank")} lead={t("sectionBankLead")}>
        {showBank ? (
          <>
            <Input
              label={optional(t("bankName"))}
              maxLength={MAX.bankName}
              value={draft.bankName}
              onChange={(e) => set({ bankName: e.target.value })}
            />
            <Input
              label={optional(t("bankAccount"))}
              maxLength={MAX.bankAccount}
              value={draft.bankAccount}
              onChange={(e) => set({ bankAccount: e.target.value })}
              className="font-mono"
            />
          </>
        ) : (
          <p className="m-0 text-kumo-subtle @lg:col-span-2">{t("bankElsewhere")}</p>
        )}
      </Section>

      <BottomBar
        className={cn(
          "justify-end md:mt-2 md:flex",
          pinned
            ? "md:sticky md:bottom-0 md:z-20 md:border-t md:border-kumo-line md:bg-kumo-canvas md:py-3"
            : "static mx-0 border-t-0 bg-transparent px-0 py-0",
          pinned && !editing && "md:-mx-8 md:px-8 lg:-mx-10 lg:px-10",
          // The record's own menu floats at the phone's bottom-right corner (ui/page.tsx ThumbActions).
          pinned && editing && "max-md:pe-[4.5rem]",
        )}
      >
        {fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} className="w-full" /> : null}
        {editing ? (
          <span className="me-auto text-kumo-subtle">{dirty ? t("editDirty") : t("editClean")}</span>
        ) : null}
        <Button type="button" variant="secondary" disabled={busy || (editing && !dirty)} onClick={cancel}>
          {common("cancel")}
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={editing && !dirty}>
          {common("save")}
        </Button>
      </BottomBar>
    </form>
  );
}
