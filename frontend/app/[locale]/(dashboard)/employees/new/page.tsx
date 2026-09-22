"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { ArrowLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import {
  EMPTY_DRAFT,
  EmployeeForm,
  type DepartmentChoice,
  type EmployeeDraft,
} from "@/components/forms/employee-form";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Link, useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";

export default function NewEmployeePage() {
  const t = useTranslations("employees");
  const common = useTranslations("common");
  const router = useRouter();
  const cache = useQueryClient();
  const [fault, setFault] = useState<string | null>(null);

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<DepartmentChoice[]>("/departments")).data,
  });

  const jobTitles = useQuery({
    queryKey: ["job-titles"],
    queryFn: async () => (await api.get<DepartmentChoice[]>("/job-titles")).data,
  });

  const entities = useQuery({
    queryKey: ["legal-entities"],
    queryFn: async () => (await api.get<DepartmentChoice[]>("/legal-entities")).data,
  });

  // A starting point only; the unique index is what settles a clash.
  const suggested = useQuery({
    queryKey: ["employees", "next-code"],
    queryFn: async () => (await api.get<{ code: string | null }>("/employees/next-code")).data,
  });

  const create = useMutation({
    mutationFn: (draft: EmployeeDraft) =>
      api.post<{ id: number }>("/employees", {
        code: draft.code,
        fullName: draft.fullName,
        legalEntityId: draft.legalEntityId || undefined,
        departmentId: draft.departmentId || undefined,
        jobTitleId: draft.jobTitleId || undefined,
        managerId: draft.managerId ? Number(draft.managerId) : undefined,
        personalEmail: draft.personalEmail || undefined,
        phone: draft.phone || undefined,
        hireDate: draft.hireDate || undefined,
        dateOfBirth: draft.dateOfBirth || undefined,
        gender: draft.gender || undefined,
        nationalId: draft.nationalId || undefined,
        taxCode: draft.taxCode || undefined,
        socialInsuranceNo: draft.socialInsuranceNo || undefined,
        bankAccount: draft.bankAccount || undefined,
        bankName: draft.bankName || undefined,
      }),
    // Their own page is where hiring carries on: contract, pay, checklist and
    // files are all tabs on it, and the roll is 5006 rows deep (KEHOACH 9.15).
    onSuccess: (made) => {
      void cache.invalidateQueries({ queryKey: ["employees"] });
      router.replace(`/employees/${made.data.id}`);
    },
    onError: (fell: unknown) => {
      // The api answers 409 when the code is taken, which is the one fault a
      // person can fix from this form.
      const clash = isAxiosError(fell) && fell.response?.status === 409;
      setFault(clash ? t("codeTaken") : common("failed"));
    },
  });

  return (
    <section className="mx-auto w-full max-w-(--width-read)">
      <Link
        href="/employees"
        className="inline-flex items-center gap-1 text-sm text-(--color-muted) hover:text-(--color-ink)"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t("title")}
      </Link>
      <h1 className="mt-2 text-lg font-semibold">{t("createTitle")}</h1>
      {departments.isError ? (
        <p role="alert" className="mt-4 text-sm text-(--color-danger)">
          {t("departmentsFailed")}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void departments.refetch()}
          >
            {common("retry")}
          </button>
        </p>
      ) : null}
      <div className="mt-6">
        {suggested.isPending ? (
          <SkeletonRows rows={4} columns={2} />
        ) : (
        <EmployeeForm
          start={{ ...EMPTY_DRAFT, code: suggested.data?.code ?? "" }}
          departments={departments.data ?? []}
          jobTitles={jobTitles.data ?? []}
          entities={entities.data ?? []}
          showActive={false}
          showBank
          showManager
          busy={create.isPending}
          fault={fault}
          onSubmit={(draft) => {
            setFault(null);
            create.mutate(draft);
          }}
          onCancel={() => router.replace("/employees")}
        />
        )}
      </div>
    </section>
  );
}
