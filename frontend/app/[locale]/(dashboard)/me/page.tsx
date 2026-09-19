"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { StatePill, type RequestRow } from "@/components/requests/request-card";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";

interface Balance {
  id: string;
  entitled: string;
  carriedOver: string;
  taken: string;
  pending: string;
  leaveType: { id: string; code: string; name: string };
}

interface Me {
  id: number;
  code: string;
  fullName: string;
  department: { id: string; name: string } | null;
}

function left(balance: Balance): number {
  return (
    Number(balance.entitled) +
    Number(balance.carriedOver) -
    Number(balance.taken) -
    Number(balance.pending)
  );
}

export default function MyPage() {
  const t = useTranslations("me");
  const r = useTranslations("requests");
  const common = useTranslations("common");
  const employeeId = useSession((s) => s.employeeId);

  const me = useQuery({
    queryKey: ["employees", employeeId],
    enabled: employeeId !== null,
    queryFn: async () => (await api.get<Me>(`/employees/${employeeId}`)).data,
  });

  const balances = useQuery({
    queryKey: ["leave-balances"],
    enabled: employeeId !== null,
    queryFn: async () => (await api.get<Balance[]>("/leave-balances")).data,
  });

  const waiting = useQuery({
    queryKey: ["requests", "mine", employeeId],
    enabled: employeeId !== null,
    queryFn: async () =>
      (await api.get<{ rows: RequestRow[]; total: number }>(`/requests?employeeId=${employeeId}`))
        .data,
  });

  if (employeeId === null) {
    return <p className="text-sm text-(--color-muted)">{t("noProfile")}</p>;
  }

  const pending = waiting.data?.rows.filter((row) => row.state === "PENDING") ?? [];

  return (
    <section className="max-w-3xl">
      <h1 className="text-lg font-semibold">
        {me.data ? t("greeting", { name: me.data.fullName }) : t("title")}
      </h1>
      <p className="mt-1 text-sm text-(--color-muted)">
        {me.data ? `${me.data.code}${me.data.department ? ` · ${me.data.department.name}` : ""}` : " "}
      </p>

      <h2 className="mt-8 text-sm font-medium">{t("leaveLeft")}</h2>
      <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {balances.isPending ? (
          <p className="text-sm text-(--color-muted)">{common("loading")}</p>
        ) : (balances.data ?? []).length === 0 ? (
          <p className="text-sm text-(--color-muted)">{common("noData")}</p>
        ) : (
          (balances.data ?? []).map((balance) => (
            <article
              key={balance.id}
              className="rounded-xl border border-(--color-line) bg-(--color-surface) p-4"
            >
              <p className="text-xs text-(--color-muted)">{balance.leaveType.name}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{left(balance)}</p>
              <p className="text-xs text-(--color-muted)">{t("daysUnit")}</p>
            </article>
          ))
        )}
      </div>

      <div className="mt-8 flex items-baseline justify-between">
        <h2 className="text-sm font-medium">{t("pendingRequests")}</h2>
        <Link href="/me/requests" className="text-sm text-(--color-accent) hover:underline">
          {r("mine")}
        </Link>
      </div>
      <div className="mt-2 rounded-xl border border-(--color-line) bg-(--color-surface)">
        {pending.length === 0 ? (
          <p className="px-4 py-6 text-sm text-(--color-muted)">{r("mineEmpty")}</p>
        ) : (
          <ul className="divide-y divide-(--color-line)">
            {pending.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span>
                  {r(`kind${row.kind}`)} · {Number(row.days)} {t("daysUnit")}
                </span>
                <StatePill state={row.state} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
