"use client";

import { Button, Empty, LayerCard, LinkButton } from "@cloudflare/kumo";
import { CheckIcon, FileXIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useState } from "react";

import { COUNTS_KEY } from "@/components/nav/waiting-count";
import {
  DecisionFields,
  RequestCard,
  StatePill,
  useDecision,
  useRequestWords,
  yearParts,
  type LeaveBalance,
  type RequestDetail,
} from "@/components/requests/request-card";
import { BottomBar } from "@/components/ui/bottom-bar";
import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { SkeletonLine } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";
import { days } from "@/lib/format";

/** One year's standing in the request's leave type; "after" while the request still waits on it. */
function BalanceCard({ balance, waiting }: { balance: LeaveBalance; waiting: boolean }) {
  const t = useTranslations("requests");
  const locale = useLocale();
  return (
    <AsideCard title={t("balancesOf", { year: balance.year })}>
      <Facts
        rows={[
          [t("balanceEntitled"), days(balance.entitled + balance.carriedOver, locale)],
          [t("balanceTaken"), days(balance.taken, locale)],
          [t("balancePending"), days(balance.pending, locale)],
          ...(balance.carriedOut > 0
            ? [[t("balanceCarriedOut"), days(balance.carriedOut, locale)] as [string, string]]
            : []),
          [
            waiting ? t("balanceAfter") : t("balanceLeft"),
            <span key="left" className="font-medium tabular-nums">
              {days(balance.remaining, locale)}
            </span>,
          ],
        ]}
      />
    </AsideCard>
  );
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
  const words = useRequestWords();
  const params = useParams<{ id: string }>();
  const cache = useQueryClient();
  const notify = useNotify();
  const faultOf = useFault();
  const decision = useDecision();
  const [fault, setFault] = useState<string | null>(null);

  const request = useQuery({
    queryKey: ["requests", "one", params.id],
    queryFn: async () => (await api.get<RequestDetail>(`/requests/${params.id}`)).data,
  });
  const row = request.data;

  const decide = useMutation({
    mutationFn: (body: { approve: boolean; note: string }) =>
      api.post(`/requests/${params.id}/decide`, { approve: body.approve, note: body.note || undefined }),
    onSuccess: (_, body) => {
      const name = row?.employee?.fullName ?? t("title");
      notify.done(body.approve ? t("approvedOf", { name }) : t("rejectedOf", { name }));
      setFault(null);
      decision.back();
      void cache.invalidateQueries({ queryKey: ["requests"] });
      void cache.invalidateQueries({ queryKey: ["leave-balances"] });
      void cache.invalidateQueries({ queryKey: COUNTS_KEY });
    },
    onError: (fell: unknown) => {
      setFault(faultOf(fell));
      void cache.invalidateQueries({ queryKey: ["requests", "one", params.id] });
    },
  });

  function send(): void {
    decision.send(
      (note) => decide.mutate({ approve: true, note }),
      (note) => decide.mutate({ approve: false, note }),
    );
  }

  const gone = isAxiosError(request.error) && request.error.response?.status === 404;

  if (request.isError && !gone) {
    return (
      <>
        <PageHeader title={t("title")} />
        <Failed onRetry={() => void request.refetch()} />
      </>
    );
  }

  const deciding = row?.state === "PENDING" && row.mayDecide;
  const charged = row ? yearParts(row).map((part) => part.year) : [];

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
                <Facts
                  rows={[
                    [t("code"), <span key="code" className="font-mono">{row.employee.code}</span>],
                    [t("department"), row.employee.department?.name ?? common("empty")],
                  ]}
                />
              </AsideCard>
              {row.balance && (row.nextBalance === null || charged.includes(row.balance.year)) ? (
                <BalanceCard balance={row.balance} waiting={row.state === "PENDING"} />
              ) : null}
              {row.nextBalance ? <BalanceCard balance={row.nextBalance} waiting={row.state === "PENDING"} /> : null}
              {row.kind === "LEAVE" && row.leaveType?.paid === false ? (
                <AsideCard title={t("balancesOf", { year: row.fromDate.slice(0, 4) })}>
                  <p className="text-kumo-subtle">{t("unpaidNoBalance")}</p>
                </AsideCard>
              ) : null}
              {row.kind === "LEAVE" ? (
                <AsideCard title={t("teamOffTitle")}>
                  {row.overlapping.length === 0 ? (
                    <p className="text-kumo-subtle">{t("teamOffNone")}</p>
                  ) : (
                    <ul className="-my-1 flex flex-col">
                      {row.overlapping.map((one) => (
                        <li key={one.id} className="flex items-center justify-between gap-3 border-b border-kumo-hairline py-2 last:border-0">
                          <Link href={`/leave/${one.id}`} className="min-w-0 truncate hover:underline">
                            {one.employee.fullName}
                          </Link>
                          <span className="flex shrink-0 items-center gap-2 text-sm text-kumo-subtle tabular-nums">
                            {words.span(one)}
                            <StatePill state={one.state} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </AsideCard>
              ) : null}
            </>
          ) : undefined
        }
      >
        {request.isPending ? (
          <LayerCard className="p-4">
            <Waiting />
          </LayerCard>
        ) : row ? (
          <RequestCard row={row}>
            {deciding ? (
              <>
                <DecisionFields decision={decision} fault={fault} noteOnApprove mayReject busy={decide.isPending} />
                <BottomBar>
                  <Button
                    variant={decision.rejecting ? "destructive" : "primary"}
                    icon={decision.rejecting ? undefined : CheckIcon}
                    loading={decide.isPending}
                    onClick={send}
                  >
                    {decision.rejecting ? t("rejectSend") : t("approve")}
                  </Button>
                </BottomBar>
              </>
            ) : null}
          </RequestCard>
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
