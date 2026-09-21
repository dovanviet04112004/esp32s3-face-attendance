"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useState } from "react";

import { RequestCard, type RequestRow } from "@/components/requests/request-card";
import { Failed } from "@/components/ui/empty";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";

const DECIDERS = ["MANAGER", "ADMIN", "HR"];

export default function LeaveDetailPage() {
  const t = useTranslations("requests");
  const params = useParams<{ id: string }>();
  const role = useSession((s) => s.role);
  const cache = useQueryClient();
  const faultOf = useFault();
  const [fault, setFault] = useState<string | null>(null);

  const rows = useQuery({
    queryKey: ["requests", "one", params.id],
    queryFn: async () => (await api.get<RequestRow>(`/requests/${params.id}`)).data,
  });

  const decide = useMutation({
    mutationFn: (body: { approve: boolean; note: string }) =>
      api.post(`/requests/${params.id}/decide`, body),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["requests"] }),
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const row = rows.data;

  return (
    <section className="mx-auto w-full max-w-(--width-read)">

      {rows.isError ? (
        <Failed onRetry={() => rows.refetch()} />
      ) : rows.isPending ? (
        <SkeletonRows rows={1} columns={3} />
      ) : row ? (
        <div className="mt-4">
          <RequestCard
            row={row}
            busy={decide.isPending}
            onDecide={
              role !== null && DECIDERS.includes(role) && row.state === "PENDING"
                ? (approve, note) => {
                    setFault(null);
                    decide.mutate({ approve, note });
                  }
                : undefined
            }
          />
        </div>
      ) : (
        <p className="mt-4 text-sm text-(--color-muted)">{t("mineEmpty")}</p>
      )}

      {fault ? (
        <p role="alert" className="mt-3 text-sm text-(--color-danger)">
          {fault}
        </p>
      ) : null}
    </section>
  );
}
