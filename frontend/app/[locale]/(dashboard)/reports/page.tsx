"use client";

import { Button, Empty, Input, LayerCard, SkeletonLine } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, BuildingsIcon, DownloadSimpleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { Failed } from "@/components/ui/failed";
import { FilterBar } from "@/components/ui/filter-bar";
import { MonthPicker, monthSpan, thisMonth, type Month } from "@/components/ui/month-picker";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, PageHeader, PageLayout } from "@/components/ui/page";
import { CountPill, StatePill } from "@/components/ui/pill";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { dayOnly, money } from "@/lib/format";

interface Entity {
  id: string;
  name: string;
}

interface Change {
  employeeId: number;
  code: string;
  fullName: string;
  socialInsuranceNo: string | null;
  reason: "HIRED" | "LEFT" | "UNPAID_14" | "SALARY_UP" | "SALARY_DOWN";
  effectiveFrom: string;
  fromSalary: string | null;
  toSalary: string | null;
}

interface Changes {
  unpaidDayThreshold: number;
  increases: Change[];
  decreases: Change[];
  adjustments: Change[];
}

const FILINGS = ["increases", "decreases", "adjustments"] as const;
const kShown = 50;

function localDay(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

// The same span the Punches page asks for, so the job warms exactly what that page reads.
function monthBounds(at: Month): { from: string; to: string } {
  const start = new Date(at.year, at.month - 1, 1);
  const end = new Date(new Date(at.year, at.month, 1).getTime() - 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

export default function ReportsPage() {
  const t = useTranslations("reports");
  const format = useFormatter();
  const locale = useLocale();
  const notify = useNotify();
  const role = useSession((s) => s.role);
  const mayRollUp = role === "ADMIN" || role === "HR";
  const [entityId, setEntityId] = useState("");
  const [month, setMonth] = useState<Month>(thisMonth);
  const [on, setOn] = useState(() => localDay(new Date()));
  const [rollMonth, setRollMonth] = useState<Month>(thisMonth);
  const span = monthSpan(month);
  const nameOf = (at: Month) => format.dateTime(new Date(at.year, at.month - 1, 15), { month: "long", year: "numeric" });

  const entities = useQuery({
    queryKey: ["legal-entities"],
    queryFn: async () => (await api.get<Entity[]>("/legal-entities")).data,
  });
  const entity = entityId || entities.data?.[0]?.id || "";
  const entityName = entities.data?.find((one) => one.id === entity)?.name ?? "";

  const changes = useQuery({
    queryKey: ["insurance-changes", entity, span.from],
    enabled: entity !== "",
    queryFn: async () =>
      (await api.get<Changes>(`/reports/insurance-changes?legalEntityId=${entity}&from=${span.from}&to=${span.to}`)).data,
  });

  const d02 = useMutation({
    mutationFn: async () => {
      const file = (await api.get<string>(`/reports/d02-lt?legalEntityId=${entity}&on=${on}`)).data;
      const link = document.createElement("a");
      // The api already opens the file with a BOM, so this must not add one.
      link.href = URL.createObjectURL(new Blob([file], { type: "text/csv;charset=utf-8" }));
      link.download = `d02-lt-${on}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    },
    onSuccess: () => notify.done(t("d02Done", { date: format.dateTime(dayOnly(on), "day") })),
    onError: notify.failed,
  });

  const rollUp = useMutation({
    mutationFn: async () => (await api.post<{ jobId: string }>("/reports/attendance/monthly", monthBounds(rollMonth))).data,
    onSuccess: () => notify.done(t("rollUpQueued", { month: nameOf(rollMonth) }), t("rollUpQueuedHint")),
    onError: notify.failed,
  });

  function line(row: Change) {
    const moved = row.fromSalary !== null && row.toSalary !== null;
    return (
      <li
        key={`${row.employeeId}-${row.reason}-${row.effectiveFrom}`}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-kumo-hairline py-2 last:border-0"
      >
        <span className="font-mono text-sm">{row.code}</span>
        <Link href={`/employees/${row.employeeId}`} className="min-w-0 truncate text-kumo-link hover:underline">
          {row.fullName}
        </Link>
        <StatePill>{t(`reason${row.reason}`)}</StatePill>
        <span className="ms-auto text-sm text-kumo-subtle tabular-nums">
          {moved ? `${money(Number(row.fromSalary), locale)} → ${money(Number(row.toSalary), locale)} · ` : ""}
          {t("effective", { date: format.dateTime(dayOnly(row.effectiveFrom), "day") })}
        </span>
      </li>
    );
  }

  const entityItems = Object.fromEntries((entities.data ?? []).map((one) => [one.id, one.name]));

  return (
    <>
      <PageHeader title={t("title")} description={t("lead")} />

      <PageLayout
        extra={
          <AsideCard title={t("exportsTitle")}>
            <div className="flex flex-col gap-3">
              <div>
                <p className="font-medium">{t("d02Title")}</p>
                <p className="text-sm text-kumo-subtle">
                  {t("d02Lead")} {entityName ? t("d02For", { name: entityName }) : null}
                </p>
              </div>
              <Input label={t("d02On")} type="date" value={on} onChange={(event) => setOn(event.target.value)} />
              <Button
                variant="secondary"
                icon={DownloadSimpleIcon}
                loading={d02.isPending}
                disabled={entity === "" || on === ""}
                onClick={() => d02.mutate()}
                className="w-full justify-start"
              >
                {t("d02Get")}
              </Button>
            </div>
            {mayRollUp ? (
              <div className="mt-4 flex flex-col gap-3 border-t border-kumo-hairline pt-4">
                <div>
                  <p className="font-medium">{t("rollUpTitle")}</p>
                  <p className="text-sm text-kumo-subtle">{t("rollUpLead")}</p>
                </div>
                <MonthPicker value={rollMonth} onChange={setRollMonth} max={thisMonth()} />
                <Button
                  variant="secondary"
                  icon={ArrowsClockwiseIcon}
                  loading={rollUp.isPending}
                  onClick={() => rollUp.mutate()}
                  className="w-full justify-start"
                >
                  {t("rollUpRun")}
                </Button>
              </div>
            ) : null}
          </AsideCard>
        }
      >
        <div className="mb-4">
          <h2 className="text-lg font-semibold">{t("insuranceTitle")}</h2>
          <p className="text-kumo-subtle">{t("insuranceLead")}</p>
        </div>
        <FilterBar
          filters={
            (entities.data?.length ?? 0) > 1
              ? [{ key: "entity", label: t("entity"), value: entity, onChange: setEntityId, items: entityItems }]
              : []
          }
          extra={<MonthPicker value={month} onChange={setMonth} max={thisMonth()} />}
        />
        {changes.isError || entities.isError ? (
          <Failed onRetry={() => void (entities.isError ? entities.refetch() : changes.refetch())} />
        ) : entities.data?.length === 0 ? (
          <LayerCard className="p-0">
            <Empty icon={<BuildingsIcon size={40} className="text-kumo-inactive" />} title={t("noEntity")} className="py-12" />
          </LayerCard>
        ) : (
          <div className="flex flex-col gap-4">
            {FILINGS.map((filing) => {
              const rows = changes.data?.[filing] ?? [];
              return (
                <LayerCard key={filing}>
                  <LayerCard.Secondary className="justify-between">
                    <span>{t(filing)}</span>
                    {changes.data ? <CountPill>{rows.length}</CountPill> : null}
                  </LayerCard.Secondary>
                  <LayerCard.Primary>
                    {!changes.data ? (
                      <div className="flex flex-col gap-3 py-1">
                        <SkeletonLine minWidth={27} maxWidth={70} />
                        <SkeletonLine minWidth={27} maxWidth={60} />
                      </div>
                    ) : rows.length === 0 ? (
                      <p className="text-kumo-subtle">{t("noneInMonth")}</p>
                    ) : (
                      <>
                        <ul className="-my-2 flex flex-col">{rows.slice(0, kShown).map(line)}</ul>
                        {rows.length > kShown ? (
                          <p className="mt-3 text-sm text-kumo-subtle">{t("andMore", { n: rows.length - kShown })}</p>
                        ) : null}
                      </>
                    )}
                  </LayerCard.Primary>
                </LayerCard>
              );
            })}
            {changes.data && entity ? (
              <p className="text-sm text-kumo-subtle">{t("unpaidRule", { days: changes.data.unpaidDayThreshold })}</p>
            ) : null}
          </div>
        )}
      </PageLayout>
    </>
  );
}
