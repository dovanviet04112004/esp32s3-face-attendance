"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { RequestCard, type RequestRow, type RequestState } from "@/components/requests/request-card";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";

const STATES: RequestState[] = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"];

export default function LeaveDeskPage() {
  const t = useTranslations("requests");
  const common = useTranslations("common");
  const [state, setState] = useState<RequestState | "">("PENDING");

  const rows = useQuery({
    queryKey: ["requests", "desk", state],
    queryFn: async () =>
      (await api.get<{ rows: RequestRow[]; total: number }>(`/requests${state ? `?state=${state}` : ""}`))
        .data,
  });

  return (
    <section className="mx-auto w-full max-w-(--width-read)">
      <h1 className="text-lg font-semibold">{t("title")}</h1>

      <div className="mt-4 mb-6 max-w-48">
        <label className="block text-xs text-(--color-muted)" htmlFor="state">
          {t("state")}
        </label>
        <Select
          id="state"
          value={state}
          onChange={(e) => setState(e.target.value as RequestState | "")}
          className="mt-1"
        >
          <option value="">{common("empty")}</option>
          {STATES.map((one) => (
            <option key={one} value={one}>
              {t(`state${one}`)}
            </option>
          ))}
        </Select>
      </div>

      {rows.isPending ? (
        <p className="text-sm text-(--color-muted)">{common("loading")}</p>
      ) : (rows.data?.rows ?? []).length === 0 ? (
        <p className="text-sm text-(--color-muted)">{common("noData")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {(rows.data?.rows ?? []).map((row) => (
            <RequestCard key={row.id} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}
