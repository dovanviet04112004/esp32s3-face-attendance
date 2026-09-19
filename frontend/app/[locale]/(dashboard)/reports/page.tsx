"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { api } from "@/lib/api";

interface Tally {
  employeeId: number;
  fullName: string;
  punches: number;
}

export default function ReportsPage() {
  const t = useTranslations("reports");
  const common = useTranslations("common");
  const year = new Date().getFullYear();
  // A year is a label, not a quantity: as a number it picks up a thousands mark.
  const shown = String(year);
  const from = new Date(Date.UTC(year, 0, 1)).toISOString();
  const to = new Date(Date.UTC(year + 1, 0, 1)).toISOString();
  const rollup = useQuery({
    queryKey: ["attendance", from, to],
    queryFn: async () =>
      (await api.get<Tally[]>(`/reports/attendance?from=${from}&to=${to}`)).data,
  });

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">{t("lead", { year: shown })}</p>

      <div className="h-80 rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
        {rollup.isPending ? (
          <p className="text-sm text-(--color-muted)">{common("loading")}</p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rollup.data ?? []}>
              <CartesianGrid stroke="var(--color-line)" vertical={false} />
              <XAxis dataKey="fullName" tick={{ fontSize: 12 }} stroke="var(--color-muted)" />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} stroke="var(--color-muted)" />
              <Tooltip />
              <Bar
                dataKey="punches"
                name={t("punches")}
                fill="var(--color-accent)"
                radius={[6, 6, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
