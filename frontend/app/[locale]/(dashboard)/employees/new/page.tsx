"use client";

import { Banner, Button, LayerCard, LinkButton, SkeletonLine } from "@cloudflare/kumo";
import type { Icon as IconType } from "@phosphor-icons/react";
import {
  ArrowClockwiseIcon,
  IdentificationCardIcon,
  KeyIcon,
  ListChecksIcon,
  ScrollIcon,
  UploadSimpleIcon,
  WalletIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
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
import { AsideCard, PageHeader, PageLayout } from "@/components/ui/page";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";

interface Taken {
  id: number;
  draft: EmployeeDraft;
}

const OUTCOMES = [
  { key: "record", icon: IdentificationCardIcon, title: "afterRecord", lead: "afterRecordLead" },
  { key: "contract", icon: ScrollIcon, title: "afterContract", lead: "afterContractLead" },
  { key: "pay", icon: WalletIcon, title: "afterPay", lead: "afterPayLead" },
  { key: "checklist", icon: ListChecksIcon, title: "afterChecklist", lead: "afterChecklistLead" },
  { key: "account", icon: KeyIcon, title: "afterAccount", lead: "afterAccountLead" },
] as const satisfies readonly { key: string; icon: IconType; title: string; lead: string }[];

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

  // Their own page is where hiring carries on: contract, pay, checklist and files are tabs on it.
  function land(taken: Taken, hired: boolean): void {
    notify.done(hired ? t("hiredToast", { name: taken.draft.fullName }) : t("createdToast", { name: taken.draft.fullName }));
    router.replace(`/employees/${taken.id}`);
  }

  const hire = useMutation({
    mutationFn: ({ id, draft }: Taken) =>
      api.post(`/employees/${id}/onboard`, {
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
      }),
    onSuccess: (_unused, taken) => land(taken, true),
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
    onSuccess: (made, draft) => {
      void cache.invalidateQueries({ queryKey: ["employees"] });
      const taken = { id: made.data.id, draft };
      setOpened(taken);
      if (!draft.hireDate) {
        land(taken, false);
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
              <Button variant="secondary" onClick={() => land(opened, false)}>
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
      <PageLayout
        aside={
          <AsideCard title={t("afterTitle")}>
            <ul className="flex flex-col gap-3">
              {OUTCOMES.map(({ key, icon: Icon, title, lead }) => (
                <li key={key} className="flex gap-3">
                  <Icon size={18} className="mt-0.5 shrink-0 text-kumo-subtle" aria-hidden />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium">{t(title)}</span>
                    <span className="text-kumo-subtle">{t(lead)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </AsideCard>
        }
        extra={
          <AsideCard title={t("manyTitle")}>
            <p className="text-kumo-subtle">{t("manyLead")}</p>
            <LinkButton href="/employees" variant="secondary" icon={UploadSimpleIcon} className="mt-1 w-full justify-start">
              {t("manyAction")}
            </LinkButton>
          </AsideCard>
        }
      >
        <div className="flex max-w-(--width-read) flex-col gap-4">
          {departments.isError ? (
            <Banner
              variant="error"
              icon={<WarningCircleIcon weight="fill" />}
              title={t("departmentsFailed")}
              action={<Banner.Action onClick={() => void departments.refetch()}>{common("retry")}</Banner.Action>}
            />
          ) : null}
          {suggested.isPending ? (
            <LayerCard className="flex flex-col gap-4 p-4">
              {Array.from({ length: 4 }, (_, at) => (
                <SkeletonLine key={at} minWidth={160} maxWidth={420} />
              ))}
            </LayerCard>
          ) : (
            <EmployeeForm
              start={{ ...EMPTY_DRAFT, code: suggested.data?.code ?? "" }}
              departments={departments.data ?? []}
              jobTitles={jobTitles.data ?? []}
              entities={entities.data ?? []}
              showActive={false}
              showBank
              showManager
              showOnboard
              fold
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
