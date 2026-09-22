"use client";

import { useQuery } from "@tanstack/react-query";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import {
  StatePill,
  type RequestKind,
  type RequestRow,
  type RequestState,
} from "@/components/requests/request-card";
import { Select } from "@/components/ui/select";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { dayOnly, days, minutes } from "@/lib/format";

const STATES: RequestState[] = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"];
const KINDS: RequestKind[] = [
  "LEAVE",
  "OVERTIME",
  "ATTENDANCE_FIX",
  "BUSINESS_TRIP",
  "REMOTE_WORK",
];

export default function RequestRegisterPage() {
  const t = useTranslations("requests");
  const format = useFormatter();
  const locale = useLocale();
  // Every state by default: filtering to pending here would repeat the
  // approvals inbox under a second sidebar entry (KEHOACH 9.15).
  const [state, setState] = useState<RequestState | "">("");
  const [kind, setKind] = useState<RequestKind | "">("");

  const where = [state ? `state=${state}` : "", kind ? `kind=${kind}` : ""]
    .filter((one) => one !== "")
    .join("&");

  const rows = useQuery({
    queryKey: ["requests", "desk", where],
    queryFn: async () =>
      (await api.get<{ rows: RequestRow[]; total: number }>(`/requests${where ? `?${where}` : ""}`))
        .data,
  });

  function span(row: RequestRow): string {
    const from = format.dateTime(dayOnly(row.fromDate), "day");
    return row.fromDate === row.toDate
      ? from
      : `${from} → ${format.dateTime(dayOnly(row.toDate), "day")}`;
  }

  const columns: Column<RequestRow>[] = [
    {
      id: "who",
      header: t("who"),
      sticky: true,
      sortBy: (row) => row.employee?.fullName ?? "",
      // The book opens onto the one screen with room to decide (KEHOACH 9.15).
      cell: (row) => (
        <Link
          href={`/leave/${row.id}`}
          className="whitespace-nowrap underline hover:no-underline"
        >
          {row.employee ? row.employee.fullName : t(`kind${row.kind}`)}
        </Link>
      ),
    },
    {
      id: "state",
      header: t("state"),
      sortBy: (row) => row.state,
      cell: (row) => <StatePill state={row.state} />,
    },
    {
      id: "kind",
      header: t("kind"),
      sortBy: (row) => row.kind,
      cell: (row) =>
        `${t(`kind${row.kind}`)}${row.leaveType ? ` · ${row.leaveType.name}` : ""}${
          row.minutes > 0 ? ` · ${minutes(row.minutes, locale)}` : ""
        }`,
    },
    { id: "range", header: t("range"), sortBy: (row) => row.fromDate, cell: span },
    {
      id: "days",
      header: t("days"),
      numeric: true,
      sortBy: (row) => Number(row.days),
      cell: (row) => days(Number(row.days), locale),
    },
    {
      id: "reason",
      header: t("reason"),
      sortBy: (row) => row.reason,
      cell: (row) => <span className="block max-w-80 truncate">{row.reason}</span>,
    },
  ];

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-(--color-muted)">{t("deskLead")}</p>

      <div className="mt-4 mb-6 flex flex-wrap gap-3">
        <div className="w-44">
          <label className="block text-xs text-(--color-muted)" htmlFor="kind">
            {t("kind")}
          </label>
          <Select
            id="kind"
            className="mt-1"
            value={kind}
            onChange={(event) => setKind(event.target.value as RequestKind | "")}
          >
            <option value="">{t("anyKind")}</option>
            {KINDS.map((one) => (
              <option key={one} value={one}>
                {t(`kind${one}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-44">
          <label className="block text-xs text-(--color-muted)" htmlFor="state">
            {t("state")}
          </label>
          <Select
            id="state"
            className="mt-1"
            value={state}
            onChange={(event) => setState(event.target.value as RequestState | "")}
          >
            <option value="">{t("anyState")}</option>
            {STATES.map((one) => (
              <option key={one} value={one}>
                {t(`state${one}`)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <DataTable
        id="requests"
        cardLead="who"
        columns={columns}
        rows={rows.data?.rows}
        keyOf={(row) => row.id}
        pending={rows.isPending}
        failed={rows.isError}
        onRetry={() => rows.refetch()}
      />
    </section>
  );
}
