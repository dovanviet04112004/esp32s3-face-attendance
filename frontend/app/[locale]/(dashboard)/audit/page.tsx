"use client";

import { Button, Combobox, LayerDialog, LinkButton, Loader } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, FunnelSimpleIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { Suspense, useEffect, useState } from "react";

import { DataTable, PersonCell, type Column } from "@/components/tables/data-table";
import { DateField } from "@/components/ui/date-field";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { api } from "@/lib/api";
import { useUrlState } from "@/lib/url-state";

interface Entry {
  id: string;
  actorId: string | null;
  actor: { email: string; employee: { code: string; fullName: string } | null } | null;
  action: string;
  subjectType: string;
  subjectId: string;
  subjectName: string | null;
  ts: string;
  meta: Record<string, unknown> | null;
}

interface EntryPage {
  rows: Entry[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
}

interface Vocabulary {
  actions: string[];
  subjects: string[];
}

interface Actor {
  id: string;
  email: string;
  name: string | null;
}

// A subject with a page of its own; the rest are read here only.
const SUBJECT_PAGE: Record<string, (id: string) => string> = {
  employee: (id) => `/employees/${id}`,
  device: (id) => `/devices/${id}`,
};

const kPage = 50;
const kPickTake = 20;
// The input also refills itself with the chosen label; only keystrokes are a search.
const TYPED: ReadonlySet<string> = new Set(["input-change", "input-clear", "clear-press"]);

function queryOf(params: Record<string, string>): string {
  const kept = Object.entries(params).filter(([, value]) => value !== "");
  return kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
}

/** The catalogue name of an action or a subject, or the raw name for one added since. */
function useVocabularyNames(): { actionName: (action: string) => string; subjectName: (subject: string) => string } {
  const actions = useTranslations("auditActions");
  const audit = useTranslations("audit");
  return {
    actionName: (action) => {
      const key = action.replace(/\./g, "_");
      return actions.has(key as never) ? actions(key as never) : action;
    },
    subjectName: (subject) => {
      const key = `subject${subject}`;
      return audit.has(key as never) ? audit(key as never) : subject;
    },
  };
}

function ActorPicker({ value, onChange }: { value: Actor | null; onChange: (next: Actor | null) => void }) {
  const t = useTranslations("audit");
  const common = useTranslations("common");
  const [typed, setTyped] = useState("");
  const asked = useSettled(typed.trim());

  const found = useQuery({
    queryKey: ["users", "list", "actor", asked],
    enabled: asked !== "",
    queryFn: async () =>
      (
        await api.get<{ rows: { id: string; email: string; employee: { fullName: string } | null }[] }>(
          `/users${queryOf({ search: asked, take: String(kPickTake) })}`,
        )
      ).data.rows.map((one): Actor => ({ id: one.id, email: one.email, name: one.employee?.fullName ?? null })),
  });
  const items = asked !== "" ? (found.data ?? []) : value ? [value] : [];

  return (
    <Combobox
      items={items}
      value={value}
      onValueChange={(next) => onChange((next as Actor | null) ?? null)}
      onInputValueChange={(next, details) => {
        if (TYPED.has(details.reason)) {
          setTyped(next);
        }
      }}
      filter={null}
      itemToStringLabel={(one: Actor) => (one.name ? `${one.name} · ${one.email}` : one.email)}
      isItemEqualToValue={(one: Actor, held: Actor) => one.id === held.id}
      label={t("actor")}
    >
      <Combobox.TriggerInput placeholder={t("actorHint")} clearLabel={common("clear")} showOptionsLabel={common("showOptions")} />
      <Combobox.Content>
        <Combobox.Empty>
          {found.isFetching ? (
            <span className="flex items-center gap-2 text-kumo-subtle">
              <Loader size={14} />
              {t("actorSearching")}
            </span>
          ) : asked !== "" ? (
            common("noMatch")
          ) : (
            t("actorHint")
          )}
        </Combobox.Empty>
        <Combobox.List>
          {(one: Actor) => (
            <Combobox.Item key={one.id} value={one}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{one.name ?? one.email}</span>
                {one.name ? <span className="truncate text-sm text-kumo-subtle">{one.email}</span> : null}
              </span>
            </Combobox.Item>
          )}
        </Combobox.List>
      </Combobox.Content>
    </Combobox>
  );
}

function Trail() {
  const t = useTranslations("audit");
  const common = useTranslations("common");
  const format = useFormatter();
  const { actionName, subjectName } = useVocabularyNames();

  const [url, setUrl] = useUrlState({ from: "", to: "", action: "", subjectType: "", subjectId: "", actorId: "" });
  const [typed, setTyped] = useState(url.subjectId);
  const settled = useSettled(typed.trim());
  useEffect(() => {
    if (settled !== url.subjectId) {
      setUrl({ subjectId: settled });
    }
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps
  const [actor, setActor] = useState<Actor | null>(null);
  const [open, setOpen] = useState<Entry | null>(null);
  const filtering = Object.values(url).some((value) => value !== "");

  const vocabulary = useQuery({
    queryKey: ["audit", "vocabulary"],
    staleTime: Infinity,
    queryFn: async () => (await api.get<Vocabulary>("/audit/vocabulary")).data,
  });

  const entries = useInfiniteQuery({
    queryKey: ["audit", "list", url],
    initialPageParam: "",
    queryFn: async ({ pageParam }) =>
      (await api.get<EntryPage>(`/audit${queryOf({ ...url, take: String(kPage), cursor: pageParam })}`)).data,
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const rows = entries.data?.pages.flatMap((one) => one.rows);
  const counted = entries.data?.pages[0];
  // A link that arrives with an actor names it by the rows it brings back.
  const shownActor =
    url.actorId === ""
      ? null
      : actor?.id === url.actorId
        ? actor
        : { id: url.actorId, email: rows?.[0]?.actor?.email ?? url.actorId, name: rows?.[0]?.actor?.employee?.fullName ?? null };

  const columns: Column<Entry>[] = [
    {
      id: "at",
      header: t("at"),
      cell: (row) => <span className="whitespace-nowrap tabular-nums">{format.dateTime(new Date(row.ts), "medium")}</span>,
    },
    { id: "action", header: t("action"), truncate: true, cell: (row) => actionName(row.action) },
    {
      id: "subject",
      header: t("subject"),
      priority: 2,
      truncate: true,
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{row.subjectName ?? row.subjectId}</span>
          <span className="truncate text-sm text-kumo-subtle">{subjectName(row.subjectType)}</span>
        </span>
      ),
    },
    {
      id: "actor",
      header: t("actor"),
      priority: 2,
      cell: (row) =>
        row.actor ? (
          <PersonCell name={row.actor.employee?.fullName ?? row.actor.email} code={row.actor.employee ? row.actor.email : null} />
        ) : (
          <span className="text-kumo-subtle">{t("system")}</span>
        ),
    },
  ];

  const pageOf = open ? SUBJECT_PAGE[open.subjectType] : undefined;

  return (
    <>
      <PageHeader title={t("title")} description={t("lead")} />

      <PageLayout>
        <div className="mb-3 grid gap-3 sm:grid-cols-3">
          <DateField
            label={t("from")}
            value={url.from}
            max={url.to || undefined}
            required={false}
            onChange={(next) => setUrl({ from: next })}
          />
          <DateField
            label={t("to")}
            value={url.to}
            min={url.from || undefined}
            required={false}
            onChange={(next) => setUrl({ to: next })}
          />
          <ActorPicker
            value={shownActor}
            onChange={(next) => {
              setActor(next);
              setUrl({ actorId: next?.id ?? "" });
            }}
          />
        </div>
        <FilterBar
          search={{ value: typed, onChange: setTyped, placeholder: t("subjectIdHint") }}
          filters={[
            {
              key: "subject",
              label: t("subject"),
              value: url.subjectType,
              onChange: (next) => setUrl({ subjectType: next }),
              items: {
                "": t("anySubject"),
                ...Object.fromEntries((vocabulary.data?.subjects ?? []).map((one) => [one, subjectName(one)])),
              },
            },
            {
              key: "action",
              label: t("action"),
              value: url.action,
              searchable: true,
              onChange: (next) => setUrl({ action: next }),
              items: {
                "": t("anyAction"),
                ...Object.fromEntries((vocabulary.data?.actions ?? []).map((one) => [one, actionName(one)])),
              },
            },
          ]}
        />
        <DataTable
          id="audit"
          cardLead="action"
          columns={columns}
          rows={rows}
          keyOf={(row) => row.id}
          pending={entries.isPending}
          failed={entries.isError}
          onRetry={() => void entries.refetch()}
          onRowClick={setOpen}
          empty={filtering ? t("empty") : t("emptyAll")}
          emptyHint={filtering ? t("emptyHint") : undefined}
          paging={
            counted
              ? {
                  shown: rows?.length ?? 0,
                  total: counted.total,
                  exact: counted.totalIsExact,
                  onMore: entries.hasNextPage ? () => void entries.fetchNextPage() : undefined,
                  loading: entries.isFetchingNextPage,
                }
              : undefined
          }
        />
      </PageLayout>

      <LayerDialog.Root open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <LayerDialog.Content size="lg" closeLabel={common("close")}>
          <LayerDialog.Title>{open ? actionName(open.action) : t("title")}</LayerDialog.Title>
          <LayerDialog.Body>
            {open ? (
              <div className="flex flex-col gap-4">
                <Facts
                  rows={[
                    [t("at"), format.dateTime(new Date(open.ts), "medium")],
                    [t("action"), <span key="action" className="font-mono text-sm">{open.action}</span>],
                    [t("subject"), `${subjectName(open.subjectType)} · ${open.subjectName ?? open.subjectId}`],
                    [t("actor"), open.actor ? (open.actor.employee?.fullName ?? open.actor.email) : t("system")],
                  ]}
                />
                <div className="flex flex-col gap-1.5">
                  <span className="font-medium">{t("meta")}</span>
                  {open.meta ? (
                    <pre className="m-0 overflow-x-auto rounded-lg bg-kumo-tint p-3 font-mono text-sm whitespace-pre-wrap break-all">
                      {JSON.stringify(open.meta, null, 2)}
                    </pre>
                  ) : (
                    <span className="text-kumo-subtle">{common("empty")}</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    icon={FunnelSimpleIcon}
                    onClick={() => {
                      setTyped(open.subjectId);
                      setUrl({ subjectType: open.subjectType, subjectId: open.subjectId });
                      setOpen(null);
                    }}
                  >
                    {t("sameSubject")}
                  </Button>
                  {pageOf ? (
                    <LinkButton href={pageOf(open.subjectId)} variant="secondary" icon={ArrowSquareOutIcon}>
                      {t("openSubject")}
                    </LinkButton>
                  ) : null}
                </div>
              </div>
            ) : null}
          </LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}

// The filters live in the query string, which the prerender does not have.
export default function AuditPage() {
  return (
    <Suspense>
      <Trail />
    </Suspense>
  );
}
