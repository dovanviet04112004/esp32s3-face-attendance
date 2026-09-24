"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { BottomBar } from "@/components/ui/bottom-bar";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { CountPill } from "@/components/ui/pill";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";

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

export type ContractKind =
  | "PROBATION"
  | "FIXED_TERM"
  | "INDEFINITE"
  | "SEASONAL"
  | "INTERNSHIP";

const KINDS: ContractKind[] = [
  "PROBATION",
  "FIXED_TERM",
  "INDEFINITE",
  "SEASONAL",
  "INTERNSHIP",
];

// Literal keys, not a built string: a missing translation has to break the
// build rather than print the key on a form (CLAUDE.md 3.1).
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
  /** UpdateEmployeeDto leaves bank details out: they move through an approved
   *  ProfileChange so the change carries a trail (KEHOACH 9.17 item 4).
   */
  showBank: boolean;
  /** An edit takes the personal email as read-only: changing it is a request with a notice (KEHOACH 9.18 rule 3). */
  lockEmail?: boolean;
  /** Only where the field starts empty: the picker reads a person out of a
   *  search and has no way back from an id already on the record.
   */
  showManager: boolean;
  /** The manager already on the record, so an edit form opens showing them. */
  manager?: Person | null;
  /** Taking somebody on writes five things at once (KEHOACH 9.14), and the
   *  first day it starts from is the hire date, asked here and nowhere else.
   */
  showOnboard: boolean;
  busy: boolean;
  fault: string | null;
  onSubmit: (draft: EmployeeDraft) => void;
  onCancel: () => void;
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-xs text-(--color-muted)">{hint}</p> : null}
    </div>
  );
}

function filledOf(values: string[]): number {
  return values.filter((one) => one !== "").length;
}

/** A group nobody has to fill today, folded away with a count of what is in
 *  it, so the two fields the server insists on are not hidden among thirteen.
 */
function Group({
  title,
  lead,
  filled,
  total,
  children,
}: {
  title: string;
  lead?: string;
  filled: number;
  total: number;
  children: ReactNode;
}) {
  // Read once: recomputing it would shut the group under somebody who is
  // clearing the last field in it.
  const [startOpen] = useState(filled > 0);
  return (
    <details
      open={startOpen}
      className="group mt-4 rounded-xl border border-(--color-line) bg-(--color-surface)"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
        <span className="text-sm font-medium">{title}</span>
        <span className="flex items-center gap-2">
          <CountPill>
            {filled}/{total}
          </CountPill>
          <ChevronDown
            className="size-4 text-(--color-muted) transition-transform group-[[open]]:rotate-180"
            aria-hidden
          />
        </span>
      </summary>
      <div className="border-t border-(--color-line) px-4 pt-3 pb-4">
        {lead ? <p className="mb-3 text-sm text-(--color-muted)">{lead}</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">{children}</div>
      </div>
    </details>
  );
}

interface Person {
  id: number;
  code: string;
  fullName: string;
}

const kSearchPauseMs = 300;
const kSearchChars = 2;

function ManagerField({ held, onPick }: { held?: Person | null; onPick: (id: string) => void }) {
  const t = useTranslations("employees");
  const [typed, setTyped] = useState(held?.code ?? "");
  const [asked, setAsked] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setAsked(typed), kSearchPauseMs);
    return () => clearTimeout(timer);
  }, [typed]);

  const found = useQuery({
    queryKey: ["employees", "manager-search", asked],
    enabled: asked.length >= kSearchChars,
    queryFn: async () =>
      (
        await api.get<{ rows: Person[] }>(
          `/employees?search=${encodeURIComponent(asked)}`,
        )
      ).data.rows,
  });

  const rows = found.data ?? [];
  const standing = held && typed === held.code ? held : undefined;
  const picked = rows.find((one) => one.code === typed) ?? standing;

  // Guarded on the value, not the callback: the parent rebuilds onPick on
  // every keystroke, and reporting on each one would feed its own re-render.
  const reported = useRef(standing ? String(standing.id) : "");
  useEffect(() => {
    const id = picked ? String(picked.id) : "";
    if (id !== reported.current) {
      reported.current = id;
      onPick(id);
    }
  }, [picked, onPick]);

  return (
    <Field id="manager" label={t("manager")} hint={t("managerHint")}>
      <Input
        id="manager"
        list="managerChoices"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        className="mt-1 font-mono"
      />
      <datalist id="managerChoices">
        {rows.map((one) => (
          <option key={one.id} value={one.code}>
            {one.fullName}
          </option>
        ))}
      </datalist>
      {picked ? <p className="mt-1 text-xs text-(--color-ok)">{picked.fullName}</p> : null}
    </Field>
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
  manager,
  showOnboard,
  busy,
  fault,
  onSubmit,
  onCancel,
}: Props) {
  const t = useTranslations("employees");
  const common = useTranslations("common");
  const [draft, setDraft] = useState(start);
  const only = entities.length === 1 ? entities[0].id : "";
  const chosen = draft.legalEntityId || only;

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({ ...draft, legalEntityId: chosen });
  }

  function set(patch: Partial<EmployeeDraft>): void {
    setDraft({ ...draft, ...patch });
  }

  return (
    <form onSubmit={submit}>
      <h2 className="text-sm font-medium">{t("sectionWho")}</h2>
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        <Field id="code" label={t("code")}>
          <Input
            id="code"
            required
            maxLength={32}
            value={draft.code}
            onChange={(e) => set({ code: e.target.value })}
            className="mt-1 font-mono"
          />
        </Field>
        <Field id="fullName" label={t("fullName")}>
          <Input
            id="fullName"
            required
            maxLength={64}
            value={draft.fullName}
            onChange={(e) => set({ fullName: e.target.value })}
            className="mt-1"
          />
        </Field>
        <Field id="legalEntity" label={t("legalEntity")} hint={t("legalEntityHint")}>
          <Select
            id="legalEntity"
            value={chosen}
            onChange={(e) => set({ legalEntityId: e.target.value })}
            className="mt-1"
          >
            <option value="">{common("empty")}</option>
            {entities.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="department" label={t("department")}>
          <Select
            id="department"
            value={draft.departmentId}
            onChange={(e) => set({ departmentId: e.target.value })}
            className="mt-1"
          >
            <option value="">{common("empty")}</option>
            {departments.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="jobTitle" label={t("jobTitle")}>
          <Select
            id="jobTitle"
            value={draft.jobTitleId}
            onChange={(e) => set({ jobTitleId: e.target.value })}
            className="mt-1"
          >
            <option value="">{common("empty")}</option>
            {jobTitles.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </Select>
        </Field>
        {showManager ? (
          <ManagerField held={manager} onPick={(id) => set({ managerId: id })} />
        ) : null}
      </div>

      {showOnboard ? (
        <Group
          title={t("sectionHire")}
          lead={t("sectionHireLead")}
          filled={filledOf([draft.hireDate, draft.baseSalary])}
          total={2}
        >
          <Field id="hireStart" label={t("hireDate")} hint={t("hireStartHint")}>
            <Input
              id="hireStart"
              type="date"
              value={draft.hireDate}
              onChange={(e) => set({ hireDate: e.target.value })}
              className="mt-1"
            />
          </Field>
          <Field id="contractKind" label={t("contractKind")}>
            <Select
              id="contractKind"
              value={draft.contractKind}
              onChange={(e) => set({ contractKind: e.target.value as ContractKind })}
              className="mt-1"
            >
              {KINDS.map((one) => (
                <option key={one} value={one}>
                  {t(KIND_KEY[one])}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="probationEnd" label={t("probationEnd")}>
            <Input
              id="probationEnd"
              type="date"
              value={draft.probationEnd}
              onChange={(e) => set({ probationEnd: e.target.value })}
              className="mt-1"
            />
          </Field>
          <Field id="contractEnd" label={t("contractEnd")} hint={t("contractEndHint")}>
            <Input
              id="contractEnd"
              type="date"
              value={draft.contractEnd}
              onChange={(e) => set({ contractEnd: e.target.value })}
              className="mt-1"
            />
          </Field>
          <Field id="baseSalary" label={t("baseSalary")}>
            <Input
              id="baseSalary"
              type="number"
              min={0}
              value={draft.baseSalary}
              onChange={(e) => set({ baseSalary: e.target.value, insuranceSalary: e.target.value })}
              className="mt-1 tabular-nums"
            />
          </Field>
          <Field id="insuranceSalary" label={t("insuranceSalary")} hint={t("insuranceSalaryHint")}>
            <Input
              id="insuranceSalary"
              type="number"
              min={0}
              value={draft.insuranceSalary}
              onChange={(e) => set({ insuranceSalary: e.target.value })}
              className="mt-1 tabular-nums"
            />
          </Field>
        </Group>
      ) : null}

      <Group
        title={t("sectionReach")}
        lead={t("sectionReachLead")}
        filled={filledOf([draft.personalEmail, draft.phone])}
        total={2}
      >
        <Field
          id="personalEmail"
          label={t("personalEmail")}
          hint={lockEmail ? t("personalEmailLocked") : t("personalEmailHint")}
        >
          <Input
            id="personalEmail"
            type="email"
            maxLength={160}
            value={draft.personalEmail}
            readOnly={lockEmail}
            onChange={(e) => set({ personalEmail: e.target.value })}
            className="mt-1"
          />
        </Field>
        <Field id="phone" label={t("phone")}>
          <Input
            id="phone"
            type="tel"
            maxLength={32}
            value={draft.phone}
            onChange={(e) => set({ phone: e.target.value })}
            className="mt-1"
          />
        </Field>
      </Group>

      <Group
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
      >
        {showOnboard ? null : (
          <Field id="hireDate" label={t("hireDate")} hint={t("hireDateHint")}>
            <Input
              id="hireDate"
              type="date"
              value={draft.hireDate}
              onChange={(e) => set({ hireDate: e.target.value })}
              className="mt-1"
            />
          </Field>
        )}
        <Field id="dateOfBirth" label={t("dateOfBirth")}>
          <Input
            id="dateOfBirth"
            type="date"
            value={draft.dateOfBirth}
            onChange={(e) => set({ dateOfBirth: e.target.value })}
            className="mt-1"
          />
        </Field>
        <Field id="gender" label={t("gender")}>
          <Select
            id="gender"
            value={draft.gender}
            onChange={(e) => set({ gender: e.target.value as EmployeeDraft["gender"] })}
            className="mt-1"
          >
            <option value="">{common("empty")}</option>
            <option value="MALE">{t("genderMALE")}</option>
            <option value="FEMALE">{t("genderFEMALE")}</option>
          </Select>
        </Field>
        <Field id="nationalId" label={t("nationalId")}>
          <Input
            id="nationalId"
            maxLength={32}
            value={draft.nationalId}
            onChange={(e) => set({ nationalId: e.target.value })}
            className="mt-1 font-mono"
          />
        </Field>
        <Field id="taxCode" label={t("taxCode")}>
          <Input
            id="taxCode"
            maxLength={32}
            value={draft.taxCode}
            onChange={(e) => set({ taxCode: e.target.value })}
            className="mt-1 font-mono"
          />
        </Field>
        <Field id="socialInsuranceNo" label={t("socialInsuranceNo")}>
          <Input
            id="socialInsuranceNo"
            maxLength={32}
            value={draft.socialInsuranceNo}
            onChange={(e) => set({ socialInsuranceNo: e.target.value })}
            className="mt-1 font-mono"
          />
        </Field>
      </Group>

      {showBank ? (
        <Group
          title={t("sectionBank")}
          lead={t("sectionBankLead")}
          filled={filledOf([draft.bankName, draft.bankAccount])}
          total={2}
        >
          <Field id="bankName" label={t("bankName")}>
            <Input
              id="bankName"
              maxLength={120}
              value={draft.bankName}
              onChange={(e) => set({ bankName: e.target.value })}
              className="mt-1"
            />
          </Field>
          <Field id="bankAccount" label={t("bankAccount")}>
            <Input
              id="bankAccount"
              maxLength={64}
              value={draft.bankAccount}
              onChange={(e) => set({ bankAccount: e.target.value })}
              className="mt-1 font-mono"
            />
          </Field>
        </Group>
      ) : (
        <p className="mt-6 text-sm text-(--color-muted)">{t("bankElsewhere")}</p>
      )}

      {showActive ? (
        <Checkbox
          className="mt-6"
          checked={draft.active}
          onChange={(e) => set({ active: e.target.checked })}
          label={t("activeLabel")}
        />
      ) : null}

      {fault ? (
        <p role="alert" className="mt-4 text-sm text-(--color-danger)">
          {fault}
        </p>
      ) : null}

      <BottomBar className="md:mt-6 md:flex">
        <Button type="submit" disabled={busy}>
          {busy ? common("saving") : common("save")}
        </Button>
        <Button type="button" tone="quiet" onClick={onCancel}>
          {common("cancel")}
        </Button>
      </BottomBar>
    </form>
  );
}
