"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { RequestCard, type RequestRow } from "@/components/requests/request-card";
import { api } from "@/lib/api";

export default function ApprovalsPage() {
  const t = useTranslations("requests");
  const common = useTranslations("common");
  const cache = useQueryClient();

  const inbox = useQuery({
    queryKey: ["requests", "inbox"],
    queryFn: async () =>
      (await api.get<{ rows: RequestRow[]; total: number }>("/requests/inbox")).data,
  });

  const decide = useMutation({
    mutationFn: (what: { id: string; approve: boolean; note: string }) =>
      api.post(`/requests/${what.id}/decide`, { approve: what.approve, note: what.note || undefined }),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["requests"] });
    },
  });

  return (
    <section className="max-w-3xl">
      <h1 className="text-lg font-semibold">{t("inbox")}</h1>
      <p className="mt-1 mb-6 text-sm text-(--color-muted)">
        {inbox.data ? `${inbox.data.total}` : " "}
      </p>

      {inbox.isPending ? (
        <p className="text-sm text-(--color-muted)">{common("loading")}</p>
      ) : inbox.data && inbox.data.rows.length > 0 ? (
        <div className="flex flex-col gap-3">
          {inbox.data.rows.map((row) => (
            <RequestCard
              key={row.id}
              row={row}
              busy={decide.isPending}
              onDecide={(approve, note) => decide.mutate({ id: row.id, approve, note })}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-(--color-muted)">{t("inboxEmpty")}</p>
      )}
    </section>
  );
}
