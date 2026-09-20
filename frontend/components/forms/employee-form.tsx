"use client";

import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { BottomBar } from "@/components/ui/bottom-bar";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

export interface EmployeeDraft {
  code: string;
  fullName: string;
  departmentId: string;
  active: boolean;
}

export interface DepartmentChoice {
  id: string;
  code: string;
  name: string;
}

interface Props {
  start: EmployeeDraft;
  departments: DepartmentChoice[];
  showActive: boolean;
  busy: boolean;
  fault: string | null;
  onSubmit: (draft: EmployeeDraft) => void;
  onCancel: () => void;
}

export function EmployeeForm({
  start,
  departments,
  showActive,
  busy,
  fault,
  onSubmit,
  onCancel,
}: Props) {
  const t = useTranslations("employees");
  const common = useTranslations("common");
  const [draft, setDraft] = useState(start);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit(draft);
  }

  return (
    <form onSubmit={submit} className="max-w-md">
      <label className="block text-sm font-medium" htmlFor="code">
        {t("code")}
      </label>
      <Input
        id="code"
        required
        maxLength={32}
        value={draft.code}
        onChange={(e) => setDraft({ ...draft, code: e.target.value })}
        className="mt-1 font-mono"
      />

      <label className="mt-4 block text-sm font-medium" htmlFor="fullName">
        {t("fullName")}
      </label>
      <Input
        id="fullName"
        required
        maxLength={64}
        value={draft.fullName}
        onChange={(e) => setDraft({ ...draft, fullName: e.target.value })}
        className="mt-1"
      />

      <label className="mt-4 block text-sm font-medium" htmlFor="department">
        {t("department")}
      </label>
      <Select
        id="department"
        value={draft.departmentId}
        onChange={(e) => setDraft({ ...draft, departmentId: e.target.value })}
        className="mt-1"
      >
        <option value="">{common("empty")}</option>
        {departments.map((department) => (
          <option key={department.id} value={department.id}>
            {department.name}
          </option>
        ))}
      </Select>

      {showActive ? (
        <Checkbox
          className="mt-4"
          checked={draft.active}
          onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
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
