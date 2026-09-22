"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { StatePill, type Tone } from "@/components/ui/pill";
import { DataTable, type Column } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";

interface Period {
  id: string;
  year: number;
  month: number;
  state: "OPEN" | "LOCKED" | "PAID";
  payDate: string | null;
}

const TONE: Record<Period["state"], Tone> = {
  OPEN: "waiting",
  LOCKED: "idle",
  PAID: "good",
};

const STATE_KEY: Record<Period["state"], "stateOPEN" | "stateLOCKED" | "statePAID"> = {
  OPEN: "stateOPEN",
  LOCKED: "stateLOCKED",
  PAID: "statePAID",
};

export default function PayrollPage() {
  const t = useTranslations("payroll");
  const common = useTranslations("common");
  const role = useSession((s) => s.role);
  const cache = useQueryClient();
  const mayWrite = role === "ADMIN" || role === "PAYROLL";
  const now = new Date();
  const [year, setYear] = useState(String(now.getUTCFullYear()));
  const [month, setMonth] = useState(String(now.getUTCMonth() + 1));

  const periods = useQuery({
    queryKey: ["payroll-periods"],
    queryFn: async () => (await api.get<Period[]>("/payroll-periods")).data,
  });

  const open = useMutation({
    mutationFn: () =>
      api.post("/payroll-periods", { year: Number(year), month: Number(month) }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["payroll-periods"] }),
  });

  const columns: Column<Period>[] = [
    {
      id: "period",
      header: t("period"),
      sticky: true,
      sortBy: (row) => row.year * 100 + row.month,
      cell: (row) => (
        <Link href={`/payroll/${row.id}`} className="underline hover:no-underline">
          {String(row.month).padStart(2, "0")}/{row.year}
        </Link>
      ),
    },
    {
      id: "state",
      header: t("state"),
      cell: (row) => (
        <StatePill tone={TONE[row.state]}>{t(STATE_KEY[row.state])}</StatePill>
      ),
    },
    {
      id: "payDate",
      header: t("period"),
      cell: (row) => row.payDate?.slice(0, 10) ?? common("empty"),
    },
  ];

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("periods")}</h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">{t("lockLead")}</p>

      {mayWrite ? (
        <form
          className="mb-4 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            open.mutate();
          }}
        >
          <Input
            aria-label={t("period")}
            type="number"
            min={2000}
            max={2100}
            value={year}
            onChange={(event) => setYear(event.target.value)}
            className="w-28"
          />
          <Input
            aria-label={t("period")}
            type="number"
            min={1}
            max={12}
            value={month}
            onChange={(event) => setMonth(event.target.value)}
            className="w-20"
          />
          <Button type="submit" disabled={open.isPending}>
            {open.isPending ? common("saving") : t("newRun")}
          </Button>
        </form>
      ) : null}

      <DataTable
        id="payroll-periods"
        columns={columns}
        rows={periods.data}
        keyOf={(row) => row.id}
        pending={periods.isPending}
        failed={periods.isError}
        onRetry={() => periods.refetch()}
        empty={t("empty")}
        emptyHint={t("emptyHint")}
      />
    </section>
  );
}
