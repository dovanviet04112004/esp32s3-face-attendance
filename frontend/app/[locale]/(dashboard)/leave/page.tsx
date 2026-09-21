"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Failed } from "@/components/ui/empty";
import {
  RequestCard,
  type RequestKind,
  type RequestRow,
  type RequestState,
} from "@/components/requests/request-card";
import { Select } from "@/components/ui/select";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";

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
  const common = useTranslations("common");
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

  if (rows.isError) {
    return <Failed onRetry={() => void rows.refetch()} />;
  }

  return (
    <section className="mx-auto w-full max-w-(--width-read)">
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-(--color-muted)">{t("deskLead")}</p>

      <div className="mt-4 mb-6 flex flex-wrap gap-3">
        <div className="w-44">
          <label className="block text-xs text-(--color-muted)" htmlFor="kind">
            {t("kind")}
          </label>
          <Select
            id="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as RequestKind | "")}
            className="mt-1"
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
            value={state}
            onChange={(e) => setState(e.target.value as RequestState | "")}
            className="mt-1"
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

      {rows.isPending ? (
        <p className="text-sm text-(--color-muted)">{common("loading")}</p>
      ) : (rows.data?.rows ?? []).length === 0 ? (
        <p className="text-sm text-(--color-muted)">{common("noData")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {(rows.data?.rows ?? []).map((row) => (
            <Link
              key={row.id}
              href={`/leave/${row.id}`}
              className="rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-accent) [&>article]:hover:border-(--color-accent)"
            >
              <RequestCard row={row} />
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
