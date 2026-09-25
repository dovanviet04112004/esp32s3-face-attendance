"use client";

import { Banner, Button, LayerCard } from "@cloudflare/kumo";
import { ArrowClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import {
  EMPTY_DRAFT,
  EmployeeForm,
  type DepartmentChoice,
  type EmployeeDraft,
} from "@/components/forms/employee-form";
import { useNotify } from "@/components/ui/notify";
import { PageHeader, PageLayout } from "@/components/ui/page";
import { SkeletonLine } from "@/components/ui/skeleton";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";

interface Taken {
  id: number;
  draft: EmployeeDraft;
}

interface Onboarding {
  skipped: string[];
}

export default function NewEmployeePage() {
  const t = useTranslations("employees");
  const common = useTranslations("common");
  const router = useRouter();
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();
  const [fault, setFault] = useState<string | null>(null);
  // Held so a hire that fell over at the second step is retried, not typed again (KEHOACH 9.14).
  const [opened, setOpened] = useState<Taken | null>(null);

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

  // Their own page is where hiring carries on, and it lists whatever joining left undone.
  function land(taken: Taken, skipped: string[] | null): void {
    notify.done(skipped ? t("hiredToast", { name: taken.draft.fullName }) : t("createdToast", { name: taken.draft.fullName }));
    const left = skipped && skipped.length > 0 ? `?skipped=${encodeURIComponent(skipped.join(","))}` : "";
    router.replace(`/employees/${taken.id}${left}`);
  }

  const hire = useMutation({
    mutationFn: async ({ id, draft }: Taken) =>
      (
        await api.post<Onboarding>(`/employees/${id}/onboard`, {
          contract: {
            kind: draft.contractKind,
            startDate: draft.hireDate,
            probationEnd: draft.probationEnd || undefined,
            endDate: draft.contractEnd || undefined,
          },
          pay: draft.baseSalary
            ? {
                baseSalary: Number(draft.baseSalary),
                insuranceSalary: Number(draft.insuranceSalary || draft.baseSalary),
              }
            : undefined,
        })
      ).data,
    onSuccess: (done, taken) => {
      void cache.invalidateQueries({ queryKey: ["users"] });
      land(taken, done.skipped);
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
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
        personalEmail: draft.personalEmail.trim() || undefined,
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
    onSuccess: (made, draft) => {
      void cache.invalidateQueries({ queryKey: ["employees"] });
      void cache.invalidateQueries({ queryKey: ["users"] });
      const taken = { id: made.data.id, draft };
      setOpened(taken);
      if (!draft.hireDate) {
        land(taken, null);
        return;
      }
      hire.mutate(taken);
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  if (opened && hire.isError) {
    return (
      <>
        <PageHeader
          title={t("hireSkipped")}
          description={`${opened.draft.code} · ${opened.draft.fullName}`}
          actions={
            <>
              <Button variant="secondary" onClick={() => land(opened, null)}>
                {t("hireOpen")}
              </Button>
              <Button
                variant="primary"
                icon={ArrowClockwiseIcon}
                loading={hire.isPending}
                onClick={() => {
                  setFault(null);
                  hire.mutate(opened);
                }}
              >
                {t("hireRetry")}
              </Button>
            </>
          }
        />
        <PageLayout>
          <div className="max-w-(--width-read)">
            <Banner
              variant="error"
              icon={<WarningCircleIcon weight="fill" />}
              title={fault ?? common("failed")}
              description={t("hireSkippedLead")}
            />
          </div>
        </PageLayout>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t("createTitle")} description={t("createLead")} />
      <PageLayout>
        <div className="flex flex-col gap-4">
          {departments.isError ? (
            <Banner
              variant="error"
              icon={<WarningCircleIcon weight="fill" />}
              title={t("departmentsFailed")}
              action={<Banner.Action onClick={() => void departments.refetch()}>{common("retry")}</Banner.Action>}
            />
          ) : null}
          {suggested.isPending || entities.isPending ? (
            Array.from({ length: 3 }, (_, at) => (
              <LayerCard key={at} className="grid gap-x-8 gap-y-5 p-6 md:grid-cols-3">
                <div className="flex flex-col gap-2">
                  <SkeletonLine minWidth={30} maxWidth={50} />
                  <SkeletonLine minWidth={60} maxWidth={90} />
                </div>
                <div className="grid gap-5 sm:grid-cols-2 md:col-span-2">
                  {Array.from({ length: 4 }, (_, cell) => (
                    <SkeletonLine key={cell} minWidth={60} maxWidth={100} blockHeight={36} />
                  ))}
                </div>
              </LayerCard>
            ))
          ) : (
            <EmployeeForm
              start={{ ...EMPTY_DRAFT, code: suggested.data?.code ?? "" }}
              departments={departments.data ?? []}
              jobTitles={jobTitles.data ?? []}
              entities={entities.data ?? []}
              showBank
              showManager
              showOnboard
              busy={create.isPending || hire.isPending}
              fault={fault}
              onSubmit={(draft) => {
                setFault(null);
                create.mutate(draft);
              }}
              onCancel={() => router.push("/employees")}
            />
          )}
        </div>
      </PageLayout>
    </>
  );
}
