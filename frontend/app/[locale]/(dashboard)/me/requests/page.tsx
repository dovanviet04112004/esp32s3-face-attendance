"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { RequestForm } from "@/components/requests/request-form";
import { RequestCard, type RequestRow } from "@/components/requests/request-card";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";

export default function MyRequestsPage() {
  const t = useTranslations("requests");
  const common = useTranslations("common");
  const cache = useQueryClient();
  const employeeId = useSession((s) => s.employeeId);
  const [filing, setFiling] = useState(false);

  const mine = useQuery({
    queryKey: ["requests", "mine", employeeId],
    enabled: employeeId !== null,
    queryFn: async () =>
      (await api.get<{ rows: RequestRow[]; total: number }>(`/requests?employeeId=${employeeId}`))
        .data,
  });

  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/requests/${id}/cancel`, {}),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["requests"] }),
  });

  return (
    <section className="max-w-3xl">
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-lg font-semibold">{t("mine")}</h1>
        {!filing ? (
          <Button size="sm" onClick={() => setFiling(true)}>
            {t("new")}
          </Button>
        ) : null}
      </div>

      {filing ? (
        <div className="mt-6">
          <RequestForm
            onDone={() => {
              setFiling(false);
              void cache.invalidateQueries({ queryKey: ["requests"] });
            }}
            onCancel={() => setFiling(false)}
          />
        </div>
      ) : null}

      <div className="mt-6 flex flex-col gap-3">
        {mine.isPending ? (
          <p className="text-sm text-(--color-muted)">{common("loading")}</p>
        ) : mine.data && mine.data.rows.length > 0 ? (
          mine.data.rows.map((row) => (
            <RequestCard
              key={row.id}
              row={row}
              busy={cancel.isPending}
              onCancel={() => cancel.mutate(row.id)}
            />
          ))
        ) : (
          <p className="text-sm text-(--color-muted)">{t("mineEmpty")}</p>
        )}
      </div>
    </section>
  );
}
