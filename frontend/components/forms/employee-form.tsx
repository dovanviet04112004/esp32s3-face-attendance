"use client";

import { Banner, Button, Checkbox, Collapsible, Input, LayerCard, Select } from "@cloudflare/kumo";
import { CaretDownIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useLocale, useTranslations } from "next-intl";
import { useState, type FormEvent, type ReactNode } from "react";

import { BottomBar } from "@/components/ui/bottom-bar";
import { PersonPicker, type Person } from "@/components/ui/person-picker";
import { CountPill } from "@/components/ui/pill";
import { cn } from "@/lib/cn";
import { money } from "@/lib/format";

export interface EmployeeDraft {
  code: string;
  fullName: string;
  legalEntityId: string;
  departmentId: string;
  jobTitleId: string;
  managerId: string;
  active: boolean;
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

export interface DepartmentChoice {
  id: string;
  code: string;
  name: string;
}

export const EMPTY_DRAFT: EmployeeDraft = {
  code: "",
  fullName: "",
  legalEntityId: "",
  departmentId: "",
  jobTitleId: "",
  managerId: "",
  active: true,
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
  showActive: boolean;
  /** UpdateEmployeeDto leaves bank details out: they move through an approved ProfileChange (KEHOACH 9.17 item 4). */
  showBank: boolean;
  /** An edit takes the personal email as read-only: changing it is a request with a notice (KEHOACH 9.18 rule 3). */
  lockEmail?: boolean;
  showManager: boolean;
  /** The manager already on the record, so an edit form opens showing them. */
  manager?: Person | null;
  /** Taking somebody on writes five things at once (KEHOACH 9.14), starting from the hire date asked here. */
  showOnboard: boolean;
  /** Folds the groups nobody has to fill today, each showing how much of it is filled. */
  fold?: boolean;
  busy: boolean;
  fault: string | null;
  onSubmit: (draft: EmployeeDraft) => void;
  /** Leaves the form; without it Cancel restores the record the form opened with. */
  onCancel?: () => void;
}

function filledOf(values: string[]): number {
  return values.filter((one) => one !== "").length;
}

function listOf(rows: DepartmentChoice[], none: string): Record<string, string> {
  return { "": none, ...Object.fromEntries(rows.map((one) => [one.id, one.name])) };
}

function Section({
  title,
  lead,
  filled,
  total,
  fold,
  children,
}: {
  title: string;
  lead?: string;
  filled?: number;
  total?: number;
  fold?: boolean;
  children: ReactNode;
}) {
  // Read once: recomputing it would shut the group under somebody clearing its last field.
  const [open, setOpen] = useState(!fold || (filled ?? 0) > 0);
  const body = (
    <>
      {lead ? <p className="text-kumo-subtle">{lead}</p> : null}
      <div className="grid items-start gap-4 sm:grid-cols-2">{children}</div>
    </>
  );

  if (!fold) {
    return (
      <LayerCard>
        <LayerCard.Secondary>{title}</LayerCard.Secondary>
        <LayerCard.Primary className="gap-4">{body}</LayerCard.Primary>
      </LayerCard>
    );
  }

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} render={<LayerCard />}>
      <LayerCard.Secondary className={cn("p-0", !open && "my-0")}>
        <Collapsible.Trigger className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-3 text-start">
          <span>{title}</span>
          <span className="flex items-center gap-2">
            <CountPill>
              {filled}/{total}
            </CountPill>
            <CaretDownIcon size={14} className={cn("transition-transform", open && "rotate-180")} aria-hidden />
          </span>
        </Collapsible.Trigger>
      </LayerCard.Secondary>
      <Collapsible.Panel render={<LayerCard.Primary className="gap-4" />}>{body}</Collapsible.Panel>
    </Collapsible.Root>
  );
}

export function EmployeeForm({
  start,
  departments,
  jobTitles,
  entities,
  showActive,
  showBank,
  lockEmail = false,
  showManager,
  manager = null,
  showOnboard,
  fold = false,
  busy,
  fault,
  onSubmit,
  onCancel,
}: Props) {
  const t = useTranslations("employees");
  const common = useTranslations("common");
  const locale = useLocale();
  const [draft, setDraft] = useState(start);
  const [boss, setBoss] = useState<Person | null>(manager);
  const only = entities.length === 1 ? entities[0].id : "";
  const chosen = draft.legalEntityId || only;
  const dirty = JSON.stringify(draft) !== JSON.stringify(start);
  const editing = onCancel === undefined;

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({ ...draft, legalEntityId: chosen });
  }

  function set(patch: Partial<EmployeeDraft>): void {
    setDraft({ ...draft, ...patch });
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

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Section title={t("sectionWho")}>
        <Input
          label={t("code")}
          required
          maxLength={32}
          value={draft.code}
          onChange={(e) => set({ code: e.target.value })}
          className="font-mono"
        />
        <Input
          label={t("fullName")}
          required
          maxLength={64}
          value={draft.fullName}
          onChange={(e) => set({ fullName: e.target.value })}
        />
        <Select
          label={t("legalEntity")}
          hideLabel={false}
          description={t("legalEntityHint")}
          value={chosen}
          onValueChange={(next) => set({ legalEntityId: String(next ?? "") })}
          items={listOf(entities, none)}
          className="w-full min-w-0"
        />
        <Select
          label={t("department")}
          hideLabel={false}
          value={draft.departmentId}
          onValueChange={(next) => set({ departmentId: String(next ?? "") })}
          items={listOf(departments, none)}
          className="w-full min-w-0"
        />
        <Select
          label={t("jobTitle")}
          hideLabel={false}
          value={draft.jobTitleId}
          onValueChange={(next) => set({ jobTitleId: String(next ?? "") })}
          items={listOf(jobTitles, none)}
          className="w-full min-w-0"
        />
        {showManager ? (
          <PersonPicker
            label={t("manager")}
            description={t("managerHint")}
            value={boss}
            onChange={(next) => {
              setBoss(next);
              set({ managerId: next ? String(next.id) : "" });
            }}
          />
        ) : null}
      </Section>

      {showOnboard ? (
        <Section
          title={t("sectionHire")}
          lead={t("sectionHireLead")}
          filled={filledOf([draft.hireDate, draft.baseSalary])}
          total={2}
          fold={fold}
        >
          <Input
            label={t("hireDate")}
            description={t("hireStartHint")}
            type="date"
            value={draft.hireDate}
            onChange={(e) => set({ hireDate: e.target.value })}
          />
          <Select
            label={t("contractKind")}
            hideLabel={false}
            value={draft.contractKind}
            onValueChange={(next) => set({ contractKind: String(next ?? "PROBATION") as ContractKind })}
            items={Object.fromEntries(KINDS.map((one) => [one, t(KIND_KEY[one])]))}
            className="w-full min-w-0"
          />
          <Input
            label={t("probationEnd")}
            type="date"
            min={draft.hireDate || undefined}
            value={draft.probationEnd}
            onChange={(e) => set({ probationEnd: e.target.value })}
          />
          <Input
            label={t("contractEnd")}
            description={t("contractEndHint")}
            type="date"
            min={draft.hireDate || undefined}
            value={draft.contractEnd}
            onChange={(e) => set({ contractEnd: e.target.value })}
          />
          <Input
            label={t("baseSalary")}
            description={amount(draft.baseSalary)}
            type="number"
            inputMode="numeric"
            min={0}
            value={draft.baseSalary}
            onChange={(e) => set({ baseSalary: e.target.value, insuranceSalary: e.target.value })}
            className="tabular-nums"
          />
          <Input
            label={t("insuranceSalary")}
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

      <Section
        title={t("sectionReach")}
        lead={t("sectionReachLead")}
        filled={filledOf([draft.personalEmail, draft.phone])}
        total={2}
        fold={fold}
      >
        <Input
          label={t("personalEmail")}
          description={lockEmail ? t("personalEmailLocked") : t("personalEmailHint")}
          type="email"
          maxLength={160}
          value={draft.personalEmail}
          readOnly={lockEmail}
          onChange={(e) => set({ personalEmail: e.target.value })}
        />
        <Input
          label={t("phone")}
          type="tel"
          maxLength={32}
          value={draft.phone}
          onChange={(e) => set({ phone: e.target.value })}
        />
      </Section>

      <Section
        title={t("sectionFiling")}
        lead={t("sectionFilingLead")}
        filled={filledOf([
          ...(showOnboard ? [] : [draft.hireDate]),
          draft.dateOfBirth,
          draft.gender,
          draft.nationalId,
          draft.taxCode,
          draft.socialInsuranceNo,
        ])}
        total={showOnboard ? 5 : 6}
        fold={fold}
      >
        {showOnboard ? null : (
          <Input
            label={t("hireDate")}
            description={t("hireDateHint")}
            type="date"
            value={draft.hireDate}
            onChange={(e) => set({ hireDate: e.target.value })}
          />
        )}
        <Input
          label={t("dateOfBirth")}
          type="date"
          value={draft.dateOfBirth}
          onChange={(e) => set({ dateOfBirth: e.target.value })}
        />
        <Select
          label={t("gender")}
          hideLabel={false}
          value={draft.gender}
          onValueChange={(next) => set({ gender: String(next ?? "") as EmployeeDraft["gender"] })}
          items={{ "": none, MALE: t("genderMALE"), FEMALE: t("genderFEMALE") }}
          className="w-full min-w-0"
        />
        <Input
          label={t("nationalId")}
          maxLength={32}
          value={draft.nationalId}
          onChange={(e) => set({ nationalId: e.target.value })}
          className="font-mono"
        />
        <Input
          label={t("taxCode")}
          maxLength={32}
          value={draft.taxCode}
          onChange={(e) => set({ taxCode: e.target.value })}
          className="font-mono"
        />
        <Input
          label={t("socialInsuranceNo")}
          maxLength={32}
          value={draft.socialInsuranceNo}
          onChange={(e) => set({ socialInsuranceNo: e.target.value })}
          className="font-mono"
        />
      </Section>

      {showBank ? (
        <Section
          title={t("sectionBank")}
          lead={t("sectionBankLead")}
          filled={filledOf([draft.bankName, draft.bankAccount])}
          total={2}
          fold={fold}
        >
          <Input
            label={t("bankName")}
            maxLength={120}
            value={draft.bankName}
            onChange={(e) => set({ bankName: e.target.value })}
          />
          <Input
            label={t("bankAccount")}
            maxLength={64}
            value={draft.bankAccount}
            onChange={(e) => set({ bankAccount: e.target.value })}
            className="font-mono"
          />
        </Section>
      ) : (
        <p className="text-kumo-subtle">{t("bankElsewhere")}</p>
      )}

      {showActive ? (
        <Checkbox
          checked={draft.active}
          onCheckedChange={(checked) => set({ active: checked === true })}
          label={t("activeLabel")}
        />
      ) : null}

      {fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null}

      <BottomBar className="md:mt-2 md:flex">
        <Button type="submit" variant="primary" loading={busy} disabled={editing && !dirty}>
          {common("save")}
        </Button>
        <Button type="button" variant="secondary" disabled={busy || (editing && !dirty)} onClick={cancel}>
          {common("cancel")}
        </Button>
      </BottomBar>
    </form>
  );
}
