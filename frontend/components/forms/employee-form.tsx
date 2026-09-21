"use client";

import { useTranslations } from "next-intl";
import { useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { BottomBar } from "@/components/ui/bottom-bar";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

export interface EmployeeDraft {
  code: string;
  fullName: string;
  legalEntityId: string;
  departmentId: string;
  jobTitleId: string;
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
}

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

export function EmployeeForm({
  start,
  departments,
  jobTitles,
  entities,
  showActive,
  showBank,
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
      </div>

      <h2 className="mt-6 text-sm font-medium">{t("sectionReach")}</h2>
      <p className="mt-1 text-sm text-(--color-muted)">{t("sectionReachLead")}</p>
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        <Field id="personalEmail" label={t("personalEmail")} hint={t("personalEmailHint")}>
          <Input
            id="personalEmail"
            type="email"
            maxLength={160}
            value={draft.personalEmail}
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
      </div>

      <h2 className="mt-6 text-sm font-medium">{t("sectionFiling")}</h2>
      <p className="mt-1 text-sm text-(--color-muted)">{t("sectionFilingLead")}</p>
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        <Field id="hireDate" label={t("hireDate")} hint={t("hireDateHint")}>
          <Input
            id="hireDate"
            type="date"
            value={draft.hireDate}
            onChange={(e) => set({ hireDate: e.target.value })}
            className="mt-1"
          />
        </Field>
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
      </div>

      {showBank ? (
        <>
          <h2 className="mt-6 text-sm font-medium">{t("sectionBank")}</h2>
          <p className="mt-1 text-sm text-(--color-muted)">{t("sectionBankLead")}</p>
          <div className="mt-2 grid gap-4 sm:grid-cols-2">
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
          </div>
        </>
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
