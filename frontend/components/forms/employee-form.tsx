"use client";

import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface EmployeeDraft {
  code: string;
  fullName: string;
  department: string;
  active: boolean;
}

interface Props {
  start: EmployeeDraft;
  showActive: boolean;
  busy: boolean;
  fault: string | null;
  onSubmit: (draft: EmployeeDraft) => void;
  onCancel: () => void;
}

export function EmployeeForm({ start, showActive, busy, fault, onSubmit, onCancel }: Props) {
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
      <Input
        id="department"
        maxLength={64}
        value={draft.department}
        onChange={(e) => setDraft({ ...draft, department: e.target.value })}
        className="mt-1"
      />

      {showActive ? (
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
            className="size-4 accent-(--color-accent)"
          />
          {t("activeLabel")}
        </label>
      ) : null}

      {fault ? (
        <p role="alert" className="mt-4 text-sm text-(--color-danger)">
          {fault}
        </p>
      ) : null}

      <div className="mt-6 flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? common("saving") : common("save")}
        </Button>
        <Button type="button" tone="quiet" onClick={onCancel}>
          {common("cancel")}
        </Button>
      </div>
    </form>
  );
}
