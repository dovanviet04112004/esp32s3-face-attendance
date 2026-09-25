"use client";

import { LayerDialog } from "@cloudflare/kumo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { useNotify } from "@/components/ui/notify";
import { StatePill } from "@/components/ui/pill";
import { api } from "@/lib/api";

export interface ToRead {
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

export type ReadFilter = "unread" | "signed" | "";

export const MY_DOCUMENTS_KEY = ["me", "documents"] as const;

/** What this person has to read; one cache entry feeds the reader and the page's counts. */
export function useMyDocuments() {
  return useQuery({
    queryKey: MY_DOCUMENTS_KEY,
    queryFn: async () => (await api.get<ToRead[]>("/me/documents")).data,
  });
}

export function DocumentReader({ only = "" }: { only?: ReadFilter }) {
  const t = useTranslations("documents");
  const common = useTranslations("common");
  const format = useFormatter();
  const cache = useQueryClient();
  const notify = useNotify();
  const mine = useMyDocuments();
  const [open, setOpen] = useState<ToRead | null>(null);

  const sign = useMutation({
    mutationFn: (versionId: string) => api.post(`/me/documents/${versionId}/ack`),
    onSuccess: () => {
      notify.done(t("signedDone", { title: open?.title ?? "" }));
      setOpen(null);
      void cache.invalidateQueries({ queryKey: MY_DOCUMENTS_KEY });
    },
    onError: notify.failed,
  });

  const rows = mine.data?.filter((row) => (only === "unread" ? row.ackAt === null : only === "signed" ? row.ackAt !== null : true));

  const columns: Column<ToRead>[] = [
    {
      id: "title",
      header: t("docTitle"),
      sortBy: (row) => row.title,
      cell: (row) => (
        <span className="flex flex-col">
          <span className="font-medium">{row.title}</span>
          {row.summary ? <span className="line-clamp-2 text-kumo-subtle">{row.summary}</span> : null}
        </span>
      ),
    },
    {
      id: "version",
      header: t("version"),
      sortBy: (row) => row.publishedAt,
      cell: (row) => (
        <span className="tabular-nums">
          {t("versionLine", { version: row.version })} · {format.dateTime(new Date(row.publishedAt), "day")}
        </span>
      ),
    },
    {
      id: "state",
      header: t("state"),
      sortBy: (row) => (row.ackAt === null ? 0 : 1),
      cell: (row) => (
        <StatePill tone={row.ackAt === null ? "waiting" : "good"}>{row.ackAt === null ? t("unread") : t("signed")}</StatePill>
      ),
    },
  ];

  return (
    <>
      <DataTable
        id="my-documents"
        cardLead="title"
        columns={columns}
        rows={rows}
        keyOf={(row) => row.versionId}
        pending={mine.isPending}
        failed={mine.isError}
        onRetry={() => void mine.refetch()}
        empty={only === "" ? t("noneToRead") : t("noneInFilter")}
        emptyHint={only === "" ? t("noneToReadHint") : undefined}
        onRowClick={setOpen}
      />

      <LayerDialog.Root open={open !== null} onOpenChange={(next) => !next && setOpen(null)} dismissDisabled={sign.isPending}>
        <LayerDialog.Content size="lg" closeLabel={common("close")}>
          <LayerDialog.Title>{open?.title ?? t("myTitle")}</LayerDialog.Title>
          <LayerDialog.Description>
            {open
              ? open.ackAt
                ? t("signedOn", { when: format.dateTime(new Date(open.ackAt), "day") })
                : `${t("versionLine", { version: open.version })} · ${format.dateTime(new Date(open.publishedAt), "day")}`
              : ""}
          </LayerDialog.Description>
          <LayerDialog.Body>
            <p className="text-base leading-relaxed whitespace-pre-wrap">{open?.body}</p>
          </LayerDialog.Body>
          {open && open.ackAt === null ? (
            <LayerDialog.Actions dismissLabel={t("later")}>
              <LayerDialog.Actions.Primary loading={sign.isPending} onClick={() => sign.mutate(open.versionId)}>
                {t("sign")}
              </LayerDialog.Actions.Primary>
            </LayerDialog.Actions>
          ) : null}
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}
