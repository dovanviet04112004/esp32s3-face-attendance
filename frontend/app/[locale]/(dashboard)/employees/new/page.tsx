"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useTranslations } from "next-intl";
import { useState } from "react";

import {
  EMPTY_DRAFT,
  EmployeeForm,
  type DepartmentChoice,
  type EmployeeDraft,
} from "@/components/forms/employee-form";
import { useRouter } from "@/i18n/navigation";
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

  const create = useMutation({
    mutationFn: (draft: EmployeeDraft) =>
      api.post("/employees", {
        code: draft.code,
        fullName: draft.fullName,
        legalEntityId: draft.legalEntityId || undefined,
        departmentId: draft.departmentId || undefined,
        jobTitleId: draft.jobTitleId || undefined,
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
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["employees"] });
      router.replace("/employees");
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
      <h1 className="text-lg font-semibold">{t("createTitle")}</h1>
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
        <EmployeeForm
          start={EMPTY_DRAFT}
          departments={departments.data ?? []}
          jobTitles={jobTitles.data ?? []}
          entities={entities.data ?? []}
          showActive={false}
          showBank
          busy={create.isPending}
          fault={fault}
          onSubmit={(draft) => {
            setFault(null);
            create.mutate(draft);
          }}
          onCancel={() => router.replace("/employees")}
        />
      </div>
    </section>
  );
}
