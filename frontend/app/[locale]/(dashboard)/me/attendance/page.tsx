"use client";

import { Empty, LayerCard, LinkButton } from "@cloudflare/kumo";
import { ClockCounterClockwiseIcon, UserCircleIcon } from "@phosphor-icons/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";

import { DataTable, type Column } from "@/components/tables/data-table";
import { AsideCard, PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill } from "@/components/ui/pill";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";

const PAGE = 50;

interface PunchPage {
  rows: Punch[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
}

interface Punch {
  id: string;
  deviceId: string;
  ts: string;
  direction: "IN" | "OUT";
  doorOpened: boolean;
  capturedOffline: boolean;
  clockUnsynced: boolean;
}

/** The punch's calendar day where the reader is, which is the day a correction names. */
function dayHere(iso: string): string {
  const at = new Date(iso);
  const pad = (one: number) => String(one).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export default function MyAttendancePage() {
  const t = useTranslations("attendance");
  const me = useTranslations("me");
  const nav = useTranslations("nav");
  const format = useFormatter();
  const router = useRouter();
  const employeeId = useSession((s) => s.employeeId);

  const punches = useInfiniteQuery({
    queryKey: ["attendance", "mine", employeeId],
    enabled: employeeId !== null,
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const after = pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : "";
      return (await api.get<PunchPage>(`/attendance?employeeId=${employeeId}&take=${PAGE}${after}`)).data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const rows = punches.data?.pages.flatMap((one) => one.rows);
  const first = punches.data?.pages[0];

  const columns: Column<Punch>[] = [
    {
      id: "at",
      header: t("at"),
      sticky: true,
      sortBy: (row) => row.ts,
      cell: (row) => <span className="tabular-nums">{format.dateTime(new Date(row.ts), "medium")}</span>,
    },
    {
      id: "direction",
      header: t("direction"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
          {t(`direction${row.direction}`)}
          {row.clockUnsynced ? <StatePill tone="waiting">{t("flagClock")}</StatePill> : null}
          {row.capturedOffline ? <StatePill>{t("flagOffline")}</StatePill> : null}
        </span>
      ),
    },
    {
      id: "device",
      header: t("deviceCol"),
      cell: (row) => <span className="font-mono text-sm">{row.deviceId}</span>,
    },
  ];

  if (employeeId === null) {
    return (
      <>
        <PageHeader title={nav("myAttendance")} />
        <LayerCard className="p-0">
          <Empty icon={<UserCircleIcon size={40} className="text-kumo-inactive" />} title={me("noProfile")} className="py-12" />
        </LayerCard>
      </>
    );
  }

  return (
    <>
      <PageHeader title={nav("myAttendance")} description={me("punchesLead")} />
      <PageLayout
        aside={
          <AsideCard title={me("fixTitle")}>
            <p className="text-kumo-subtle">{me("fixLead")}</p>
            <LinkButton
              href="/me/requests?new=ATTENDANCE_FIX"
              variant="secondary"
              icon={ClockCounterClockwiseIcon}
              className="mt-3 w-full justify-start"
            >
              {me("fixAsk")}
            </LinkButton>
          </AsideCard>
        }
      >
        <DataTable
          id="my-attendance"
          cardLead="at"
          columns={columns}
          rows={rows}
          keyOf={(row) => row.id}
          pending={punches.isPending}
          failed={punches.isError}
          onRetry={() => void punches.refetch()}
          empty={me("punchesEmpty")}
          emptyHint={me("punchesEmptyHint")}
          rowActions={(row) => [
            {
              key: "fix",
              label: me("fixThisDay"),
              icon: ClockCounterClockwiseIcon,
              onSelect: () => router.push(`/me/requests?new=ATTENDANCE_FIX&date=${dayHere(row.ts)}`),
            },
          ]}
          paging={
            first
              ? {
                  shown: rows?.length ?? 0,
                  total: first.total,
                  exact: first.totalIsExact,
                  onMore: punches.hasNextPage ? () => void punches.fetchNextPage() : undefined,
                  loading: punches.isFetchingNextPage,
                }
              : undefined
          }
        />
      </PageLayout>
    </>
  );
}
