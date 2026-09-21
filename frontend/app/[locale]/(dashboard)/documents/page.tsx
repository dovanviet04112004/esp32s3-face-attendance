"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { FileGaps } from "@/components/documents/file-gaps";
import { Button } from "@/components/ui/button";
import { Empty, Failed } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";

interface Version {
  id: string;
  version: number;
  publishedAt: string;
  summary: string | null;
}

interface Doc {
  id: string;
  code: string;
  title: string;
  departmentId: string | null;
  jobTitleId: string | null;
  versions: Version[];
}

interface Reader {
  employeeId: number;
  code: string;
  fullName: string;
  ackAt: string | null;
}

export default function DocumentsPage() {
  const t = useTranslations("documents");
  const common = useTranslations("common");
  const cache = useQueryClient();
  const faultOf = useFault();
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  const docs = useQuery({
    queryKey: ["documents"],
    queryFn: async () => (await api.get<Doc[]>("/documents")).data,
  });

  const readers = useQuery({
    queryKey: ["documents", open, "readers"],
    enabled: open !== null,
    queryFn: async () => (await api.get<Reader[]>(`/documents/${open}/readers`)).data,
  });

  function done(): void {
    setRefused(null);
    void cache.invalidateQueries({ queryKey: ["documents"] });
  }

  const create = useMutation({
    mutationFn: () => api.post("/documents", { code, title }),
    onSuccess: () => {
      setCode("");
      setTitle("");
      done();
    },
    onError: (fell) => setRefused(faultOf(fell)),
  });

  const publish = useMutation({
    mutationFn: (id: string) => api.post(`/documents/${id}/versions`, { body: body[id] ?? "" }),
    onSuccess: (_result, id) => {
      setBody((was) => ({ ...was, [id]: "" }));
      done();
    },
    onError: (fell) => setRefused(faultOf(fell)),
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    create.mutate();
  }

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-(--color-muted)">{t("lead")}</p>

      <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-xs text-(--color-muted)" htmlFor="code">
            {t("code")}
          </label>
          <Input id="code" required value={code} onChange={(e) => setCode(e.target.value)} className="mt-1" />
        </div>
        <div className="min-w-48 flex-1">
          <label className="block text-xs text-(--color-muted)" htmlFor="title">
            {t("docTitle")}
          </label>
          <Input id="title" required value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" />
        </div>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? common("saving") : t("add")}
        </Button>
      </form>

      {refused ? (
        <p role="alert" className="mt-3 text-sm text-(--color-danger)">
          {refused}
        </p>
      ) : null}

      {docs.isError ? <Failed onRetry={() => docs.refetch()} /> : null}
      {docs.isPending ? <SkeletonRows rows={2} columns={3} /> : null}
      {docs.isSuccess && docs.data.length === 0 ? (
        <div className="mt-4">
          <Empty title={t("none")} hint={t("noneHint")} />
        </div>
      ) : null}

      <ul className="mt-4 flex flex-col gap-2">
        {(docs.data ?? []).map((doc) => {
          const latest = doc.versions[0];
          return (
            <li
              key={doc.id}
              className="rounded-xl border border-(--color-line) bg-(--color-surface) p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium">
                  {doc.title} <span className="text-(--color-muted)">· {doc.code}</span>
                </p>
                <span className="text-xs text-(--color-muted) tabular-nums">
                  {latest ? t("versionLine", { version: latest.version }) : t("neverPublished")}
                </span>
              </div>

              <label className="mt-3 block text-xs text-(--color-muted)" htmlFor={`body-${doc.id}`}>
                {t("nextVersion")}
              </label>
              <textarea
                id={`body-${doc.id}`}
                rows={4}
                value={body[doc.id] ?? ""}
                onChange={(e) => setBody((was) => ({ ...was, [doc.id]: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-(--color-line) bg-(--color-surface) p-2 text-sm"
              />
              <p className="mt-1 text-xs text-(--color-muted)">{t("publishWarning")}</p>

              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={publish.isPending || !(body[doc.id] ?? "").trim()}
                  onClick={() => publish.mutate(doc.id)}
                >
                  {publish.isPending ? common("saving") : t("publish")}
                </Button>
                {latest ? (
                  <Button
                    type="button"
                    tone="quiet"
                    size="sm"
                    onClick={() => setOpen(open === doc.id ? null : doc.id)}
                  >
                    {open === doc.id ? t("hide") : t("whoSigned")}
                  </Button>
                ) : null}
              </div>

              {open === doc.id && readers.isSuccess ? (
                <ul className="mt-3 flex flex-col gap-1 text-sm">
                  {readers.data.map((one) => (
                    <li key={one.employeeId} className="flex justify-between gap-3">
                      <span>
                        {one.fullName} <span className="text-(--color-muted)">· {one.code}</span>
                      </span>
                      <span
                        className={one.ackAt ? "text-(--color-ok)" : "text-(--color-warn)"}
                      >
                        {one.ackAt ? t("signed") : t("unread")}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>

      <h2 className="mt-8 text-sm font-medium">{t("gapsTitle")}</h2>
      <p className="mt-1 mb-2 text-sm text-(--color-muted)">{t("gapsLead")}</p>
      <FileGaps />
    </section>
  );
}
