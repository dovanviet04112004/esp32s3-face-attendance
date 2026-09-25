"use client";

import { useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";

import { AsideCard } from "@/components/ui/page";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { dayOnly } from "@/lib/format";

interface Holiday {
  id: string;
  date: string;
  name: string;
}

const kDayMs = 86_400_000;

function localDay(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

/** The first holiday from today on, looking into next year when this one has none left.
 *  @param linked adds a link to the holiday calendar; the calendar itself leaves it off.
 */
export function NextHoliday({ linked = true }: { linked?: boolean }) {
  const t = useTranslations("holidays");
  const format = useFormatter();
  const today = localDay(new Date());
  const year = Number(today.slice(0, 4));
  const ahead = useQuery({
    queryKey: ["holidays", "ahead", today],
    queryFn: async () => {
      const both = await Promise.all([year, year + 1].map(async (one) => (await api.get<Holiday[]>(`/holidays?year=${one}`)).data));
      return both.flat().filter((one) => one.date.slice(0, 10) >= today).sort((left, right) => left.date.localeCompare(right.date))[0] ?? null;
    },
  });

  if (ahead.data === undefined) {
    return null;
  }
  if (ahead.data === null) {
    return (
      <AsideCard title={t("nextTitle")}>
        <p className="text-kumo-subtle">{t("nextNone", { year: year + 1 })}</p>
      </AsideCard>
    );
  }
  const inDays = Math.round((dayOnly(ahead.data.date).getTime() - dayOnly(today).getTime()) / kDayMs);
  return (
    <AsideCard
      title={t("nextTitle")}
      action={
        linked ? (
          <Link href="/holidays" className="text-sm font-normal text-kumo-link hover:underline">
            {t("seeCalendar")}
          </Link>
        ) : undefined
      }
    >
      <p className="font-medium">{ahead.data.name}</p>
      <p className="text-kumo-subtle">
        {format.dateTime(dayOnly(ahead.data.date), { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
        {" · "}
        {t("inDays", { count: inDays })}
      </p>
    </AsideCard>
  );
}
