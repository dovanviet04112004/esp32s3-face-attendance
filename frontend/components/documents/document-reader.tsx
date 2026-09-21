"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Empty, Failed } from "@/components/ui/empty";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";

interface ToRead {
  documentId: string;
  code: string;
  title: string;
  versionId: string;
  version: number;
  body: string;
  summary: string | null;
  publishedAt: string;
  ackAt: string | null;
}

/** What somebody has to read, with the signature that binds to this wording. */
export function DocumentReader() {
  const t = useTranslations("documents");
  const common = useTranslations("common");
  const format = useFormatter();
  const cache = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);

  const mine = useQuery({
    queryKey: ["me", "documents"],
    queryFn: async () => (await api.get<ToRead[]>("/me/documents")).data,
  });

  const sign = useMutation({
    mutationFn: (versionId: string) => api.post(`/me/documents/${versionId}/ack`),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["me", "documents"] }),
  });

  if (mine.isError) {
    return <Failed onRetry={() => mine.refetch()} />;
  }
  if (mine.isPending) {
    return <SkeletonRows rows={3} columns={2} />;
  }
  if (mine.data.length === 0) {
    return <Empty title={t("noneToRead")} hint={t("noneToReadHint")} />;
  }

  return (
    <ul className="flex flex-col gap-2">
      {mine.data.map((row) => {
        const showing = open === row.versionId;
        return (
          <li
            key={row.versionId}
            className={cn(
              "rounded-xl border bg-(--color-surface) p-4",
              row.ackAt === null ? "border-(--color-warn)" : "border-(--color-line)",
            )}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-medium">{row.title}</p>
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs",
                  row.ackAt === null
                    ? "border-(--color-warn) text-(--color-warn)"
                    : "border-(--color-ok) text-(--color-ok)",
                )}
              >
                {row.ackAt === null ? t("unread") : t("signed")}
              </span>
            </div>
            <p className="mt-1 text-xs text-(--color-muted)">
              {t("versionLine", { version: row.version })} ·{" "}
              {format.dateTime(new Date(row.publishedAt), "day")}
            </p>
            {row.summary ? <p className="mt-2 text-sm">{row.summary}</p> : null}

            <Button
              type="button"
              tone="quiet"
              size="sm"
              className="mt-3"
              onClick={() => setOpen(showing ? null : row.versionId)}
            >
              {showing ? t("hide") : t("read")}
            </Button>

            {showing ? (
              <div className="mt-3 max-h-96 overflow-y-auto rounded-lg bg-(--color-ground) p-3">
                <p className="text-sm whitespace-pre-wrap">{row.body}</p>
              </div>
            ) : null}

            {row.ackAt === null && showing ? (
              <Button
                type="button"
                className="mt-3"
                disabled={sign.isPending && sign.variables === row.versionId}
                onClick={() => sign.mutate(row.versionId)}
              >
                {sign.isPending && sign.variables === row.versionId
                  ? common("saving")
                  : t("sign")}
              </Button>
            ) : null}

            {row.ackAt ? (
              <p className="mt-2 text-xs text-(--color-muted)">
                {t("signedOn", { when: format.dateTime(new Date(row.ackAt), "day") })}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
