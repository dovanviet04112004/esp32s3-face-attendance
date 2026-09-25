"use client";

import { Empty, LayerCard, LinkButton, SkeletonLine } from "@cloudflare/kumo";
import { FileXIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useFormatter, useTranslations } from "next-intl";
import { useParams } from "next/navigation";

import { RequestCard, StatePill, useLeaveBalances, type RequestRow } from "@/components/requests/request-card";
import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";

const DECIDERS = ["MANAGER", "ADMIN", "HR"];

interface Employee {
  id: number;
  code: string;
  fullName: string;
  department: { id: string; name: string } | null;
}

function Waiting() {
  return (
    <div className="flex flex-col gap-3 py-1">
      <SkeletonLine minWidth={25} maxWidth={37} />
      <SkeletonLine minWidth={25} maxWidth={43} />
    </div>
  );
}

export default function LeaveDetailPage() {
  const t = useTranslations("requests");
  const common = useTranslations("common");
  const format = useFormatter();
  const params = useParams<{ id: string }>();
  const role = useSession((s) => s.role);
  const cache = useQueryClient();
  const notify = useNotify();

  const request = useQuery({
    queryKey: ["requests", "one", params.id],
    queryFn: async () => (await api.get<RequestRow>(`/requests/${params.id}`)).data,
  });
  const row = request.data;
  const whoId = row?.employee?.id;

  const employee = useQuery({
    queryKey: ["employees", whoId],
    enabled: whoId !== undefined,
    queryFn: async () => (await api.get<Employee>(`/employees/${whoId}`)).data,
  });

  const balances = useLeaveBalances(whoId, row?.fromDate ?? "", row !== undefined);

  const decide = useMutation({
    mutationFn: (body: { approve: boolean; note: string }) =>
      api.post(`/requests/${params.id}/decide`, { approve: body.approve, note: body.note || undefined }),
    onSuccess: (_, body) => {
      const name = row?.employee?.fullName ?? "none";
      notify.done(body.approve ? t("approvedOf", { name }) : t("rejectedOf", { name }));
      void cache.invalidateQueries({ queryKey: ["requests"] });
      void cache.invalidateQueries({ queryKey: ["leave-balances"] });
    },
    onError: notify.failed,
  });

  const person = employee.data;
  const year = row?.fromDate.slice(0, 4) ?? "";

  const gone = isAxiosError(request.error) && request.error.response?.status === 404;

  if (request.isError && !gone) {
    return (
      <>
        <PageHeader title={t("title")} />
        <Failed onRetry={() => void request.refetch()} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={row ? `${row.employee?.fullName ?? t("title")} · ${t(`kind${row.kind}`)}` : t("title")}
        meta={row ? <StatePill state={row.state} /> : undefined}
        description={row ? t("filedOn", { date: format.dateTime(new Date(row.createdAt), "day") }) : undefined}
      />

      <PageLayout
        aside={
          row?.employee ? (
            <>
              <AsideCard
                title={t("requester")}
                action={
                  <Link href={`/employees/${row.employee.id}`} className="text-sm font-normal text-kumo-link hover:underline">
                    {t("openProfile")}
                  </Link>
                }
              >
                {person ? (
                  <Facts
                    rows={[
                      [t("code"), <span key="code" className="font-mono">{person.code}</span>],
                      [t("department"), person.department?.name ?? common("empty")],
                    ]}
                  />
                ) : employee.isError ? (
                  <Facts rows={[[t("code"), <span key="code" className="font-mono">{row.employee.code}</span>]]} />
                ) : (
                  <Waiting />
                )}
              </AsideCard>
              <AsideCard title={t("balancesOf", { year })}>
                {balances.isPending ? (
                  <Waiting />
                ) : balances.isError ? (
                  <Failed onRetry={() => void balances.refetch()} />
                ) : balances.data.length === 0 ? (
                  <p className="text-kumo-subtle">{t("balancesNone")}</p>
                ) : (
                  <Facts
                    rows={balances.data.map((one) => [
                      one.name,
                      <span
                        key={one.leaveTypeId}
                        className={cn(
                          "tabular-nums",
                          one.leaveTypeId === row.leaveType?.id && "font-medium",
                          one.remaining < 0 && "text-kumo-danger",
                        )}
                      >
                        {t("balanceValue", { left: one.remaining, total: one.entitled + one.carriedOver })}
                      </span>,
                    ])}
                  />
                )}
              </AsideCard>
            </>
          ) : undefined
        }
      >
        {request.isPending ? (
          <LayerCard className="p-4">
            <Waiting />
          </LayerCard>
        ) : row ? (
          <RequestCard
            row={row}
            busy={decide.isPending}
            onDecide={
              role !== null && DECIDERS.includes(role) && row.state === "PENDING"
                ? (approve, note) => decide.mutate({ approve, note })
                : undefined
            }
          />
        ) : (
          <LayerCard className="p-0">
            <Empty
              icon={<FileXIcon size={40} className="text-kumo-inactive" />}
              title={t("gone")}
              contents={
                <LinkButton href="/leave" variant="secondary">
                  {t("nothingWaitingGo")}
                </LinkButton>
              }
              className="py-12"
            />
          </LayerCard>
        )}
      </PageLayout>
    </>
  );
}
