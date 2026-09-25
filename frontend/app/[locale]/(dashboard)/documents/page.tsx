"use client";

import { Banner, Button, Checkbox, Empty, Input, LayerCard, LayerDialog, SkeletonLine, Textarea } from "@cloudflare/kumo";
import { MegaphoneIcon, PlusIcon, UsersIcon, WarningCircleIcon, WarningIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { FileGaps } from "@/components/documents/file-gaps";
import { DataTable, PagingRow, type Column } from "@/components/tables/data-table";
import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, PageHeader, PageLayout, StatList } from "@/components/ui/page";
import { StatePill } from "@/components/ui/pill";
import { Link, useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";

const TABS = ["publish", "gaps", "types"] as const;
const TAB_KEY = { publish: "tabPublish", gaps: "tabGaps", types: "tabTypes" } as const;
const kReadersPage = 50;

type Tab = (typeof TABS)[number];

interface Version {
  id: string;
  version: number;
  publishedAt: string;
  summary: string | null;
}

interface FileType {
  id: string;
  code: string;
  name: string;
  required: boolean;
  validMonths: number | null;
}

interface Doc {
  id: string;
  code: string;
  title: string;
  versions: Version[];
}

interface Reader {
  employeeId: number;
  code: string;
  fullName: string;
  ackAt: string | null;
}

interface ReaderPage {
  rows: Reader[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
  unread: number;
  unreadIsExact: boolean;
}

interface Signing {
  reach: number;
  unsigned: number;
  floor: boolean;
}

export default function DocumentsPage() {
  const t = useTranslations("documents");
  const common = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const search = useSearchParams();
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();

  const asked = search.get("tab") as Tab | null;
  const tab: Tab = asked && TABS.includes(asked) ? asked : "publish";

  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [publishing, setPublishing] = useState<Doc | null>(null);
  const [body, setBody] = useState("");
  const [summary, setSummary] = useState("");
  const [reading, setReading] = useState<Doc | null>(null);
  const [typing, setTyping] = useState(false);
  const [typeCode, setTypeCode] = useState("");
  const [typeName, setTypeName] = useState("");
  const [typeMonths, setTypeMonths] = useState("");
  const [typeRequired, setTypeRequired] = useState(true);
  const [fault, setFault] = useState<string | null>(null);

  function pick(next: string): void {
    router.replace(next === "publish" ? "/documents" : `/documents?tab=${next}`, { scroll: false });
  }

  const docs = useQuery({
    queryKey: ["documents"],
    queryFn: async () => (await api.get<Doc[]>("/documents")).data,
  });

  const published = (docs.data ?? []).filter((doc) => doc.versions.length > 0);
  const signings = useQueries({
    queries: published.map((doc) => ({
      queryKey: ["documents", doc.id, "readers", "count", doc.versions[0].version],
      queryFn: async (): Promise<Signing> => {
        const page = (await api.get<ReaderPage>(`/documents/${doc.id}/readers?take=1`)).data;
        return { reach: page.total, unsigned: page.unread, floor: !page.unreadIsExact };
      },
    })),
  });
  const signingOf = new Map(published.map((doc, at) => [doc.id, signings[at]?.data]));
  const unsignedTotal = signings.reduce((sum, one) => sum + (one.data?.unsigned ?? 0), 0);
  const unsignedFloor = signings.some((one) => one.data?.floor);

  const gapCount = useQuery({
    queryKey: ["personnel-files", "gaps", "count"],
    queryFn: async () => (await api.get<{ total: number; totalIsExact?: boolean }>("/personnel-files/gaps?take=1")).data,
  });

  const types = useQuery({
    queryKey: ["personnel-file-types"],
    queryFn: async () => (await api.get<FileType[]>("/personnel-file-types")).data,
  });

  const readers = useInfiniteQuery({
    queryKey: ["documents", reading?.id, "readers", "list"],
    enabled: reading !== null,
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const after = pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : "";
      return (await api.get<ReaderPage>(`/documents/${reading?.id}/readers?take=${kReadersPage}${after}`)).data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

  function openPublish(doc: Doc): void {
    setFault(null);
    setBody("");
    setSummary("");
    setReading(null);
    setPublishing(doc);
  }

  const create = useMutation({
    mutationFn: async () => (await api.post<Doc>("/documents", { code: code.trim(), title: title.trim() })).data,
    onSuccess: (made) => {
      setAdding(false);
      notify.done(t("addedToast", { code: made.code }));
      void cache.invalidateQueries({ queryKey: ["documents"] });
      openPublish({ ...made, versions: [] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const publish = useMutation({
    mutationFn: async (doc: Doc) =>
      (await api.post<Version>(`/documents/${doc.id}/versions`, { body, summary: summary.trim() || undefined })).data,
    onSuccess: (made, doc) => {
      setPublishing(null);
      notify.done(t("publishedToast", { version: made.version, title: doc.title }));
      void cache.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const addType = useMutation({
    mutationFn: () =>
      api.post("/personnel-file-types", {
        code: typeCode.trim(),
        name: typeName.trim(),
        required: typeRequired,
        validMonths: typeMonths ? Number(typeMonths) : undefined,
      }),
    onSuccess: () => {
      setTyping(false);
      notify.done(t("typeAddedToast", { name: typeName.trim() }));
      void cache.invalidateQueries({ queryKey: ["personnel-file-types"] });
      void cache.invalidateQueries({ queryKey: ["personnel-files"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function openAdd(): void {
    setFault(null);
    setCode("");
    setTitle("");
    setAdding(true);
  }

  function openType(): void {
    setFault(null);
    setTypeCode("");
    setTypeName("");
    setTypeMonths("");
    setTypeRequired(true);
    setTyping(true);
  }

  const day = (iso: string) => format.dateTime(new Date(iso), "day");

  const docColumns: Column<Doc>[] = [
    {
      id: "title",
      header: t("docTitle"),
      sticky: true,
      sortBy: (row) => row.title,
      cell: (row) => (
        <span className="flex flex-col">
          <span>{row.title}</span>
          <span className="font-mono text-sm text-kumo-subtle">{row.code}</span>
        </span>
      ),
    },
    {
      id: "version",
      header: t("version"),
      sortBy: (row) => row.versions[0]?.version ?? 0,
      cell: (row) =>
        row.versions[0] ? (
          <span className="flex flex-col">
            <span>{t("versionLine", { version: row.versions[0].version })}</span>
            <span className="text-sm text-kumo-subtle tabular-nums">{day(row.versions[0].publishedAt)}</span>
          </span>
        ) : (
          <StatePill tone="waiting">{t("neverPublished")}</StatePill>
        ),
    },
    {
      id: "unsigned",
      header: t("unsignedColumn"),
      numeric: true,
      sortBy: (row) => signingOf.get(row.id)?.unsigned ?? -1,
      cell: (row) => {
        const seen = signingOf.get(row.id);
        if (!seen || seen.reach === 0) {
          return common("empty");
        }
        return seen.unsigned > 0 ? (
          <span className="font-medium text-kumo-warning">{seen.floor ? `${seen.unsigned}+` : seen.unsigned}</span>
        ) : (
          <StatePill tone="good">{t("allSigned")}</StatePill>
        );
      },
    },
    {
      id: "reach",
      header: t("reach"),
      numeric: true,
      cell: (row) => {
        const seen = signingOf.get(row.id);
        return seen ? seen.reach : common("empty");
      },
    },
  ];

  const typeColumns: Column<FileType>[] = [
    {
      id: "type",
      header: t("typeName"),
      sticky: true,
      sortBy: (row) => row.name,
      cell: (row) => (
        <span className="flex flex-col">
          <span>{row.name}</span>
          <span className="font-mono text-sm text-kumo-subtle">{row.code}</span>
        </span>
      ),
    },
    {
      id: "required",
      header: t("requiredColumn"),
      sortBy: (row) => (row.required ? 1 : 0),
      cell: (row) => (row.required ? <StatePill tone="waiting">{t("requiredMark")}</StatePill> : <StatePill>{t("optionalMark")}</StatePill>),
    },
    {
      id: "valid",
      header: t("validMonthsField"),
      sortBy: (row) => row.validMonths ?? 0,
      cell: (row) => (row.validMonths ? t("validMonths", { count: row.validMonths }) : t("noExpiry")),
    },
  ];

  const faultBanner = fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} className="mt-4" /> : null;
  const readerRows = readers.data?.pages.flatMap((one) => one.rows);
  const firstReaders = readers.data?.pages[0];
  const latest = reading?.versions[0];

  const actions =
    tab === "publish" ? (
      <Button variant="primary" icon={PlusIcon} onClick={openAdd}>
        {t("add")}
      </Button>
    ) : tab === "types" ? (
      <Button variant="primary" icon={PlusIcon} onClick={openType}>
        {t("addType")}
      </Button>
    ) : undefined;

  function panel() {
    if (tab === "gaps") {
      return (
        <div className="flex flex-col gap-3">
          <p className="text-kumo-subtle">{t("gapsLead")}</p>
          <FileGaps />
        </div>
      );
    }
    if (tab === "types") {
      return (
        <div className="flex flex-col gap-3">
          <p className="text-kumo-subtle">{t("typesLead")}</p>
          <DataTable
            id="file-types"
            cardLead="type"
            columns={typeColumns}
            rows={types.data}
            keyOf={(row) => row.id}
            pending={types.isPending}
            failed={types.isError}
            onRetry={() => void types.refetch()}
            empty={t("typesEmptyTitle")}
            emptyHint={t("typesEmpty")}
            emptyAction={
              <Button variant="secondary" icon={PlusIcon} onClick={openType}>
                {t("addType")}
              </Button>
            }
          />
        </div>
      );
    }
    return (
      <DataTable
        id="documents"
        cardLead="title"
        columns={docColumns}
        rows={docs.data}
        keyOf={(row) => row.id}
        pending={docs.isPending}
        failed={docs.isError}
        onRetry={() => void docs.refetch()}
        empty={t("none")}
        emptyHint={t("noneHint")}
        emptyAction={
          <Button variant="secondary" icon={PlusIcon} onClick={openAdd}>
            {t("add")}
          </Button>
        }
        onRowClick={(row) => (row.versions.length > 0 ? setReading(row) : openPublish(row))}
        rowActions={(row) => [
          ...(row.versions.length > 0
            ? [{ key: "readers", label: t("whoSigned"), icon: UsersIcon, onSelect: () => setReading(row) }]
            : []),
          { key: "publish", label: t("publishNext"), icon: MegaphoneIcon, onSelect: () => openPublish(row) },
        ]}
      />
    );
  }

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("lead")}
        actions={actions}
        tabs={TABS.map((one) => ({ value: one, label: t(TAB_KEY[one]) }))}
        tab={tab}
        onTab={pick}
      />

      <PageLayout
        aside={
          <AsideCard title={common("summary")}>
            <StatList
              stats={[
                {
                  key: "docs",
                  label: t("docCount"),
                  value: docs.isSuccess ? docs.data.length : common("empty"),
                  active: tab === "publish",
                  onPick: () => pick("publish"),
                },
                {
                  key: "unsigned",
                  label: t("unsignedCount"),
                  value: docs.isSuccess && signings.every((one) => one.isSuccess) ? `${format.number(unsignedTotal)}${unsignedFloor ? "+" : ""}` : common("empty"),
                  tone: unsignedTotal > 0 ? "warning" : undefined,
                  onPick: () => pick("publish"),
                },
                {
                  key: "gaps",
                  label: t("gapCount"),
                  value: gapCount.isSuccess ? `${format.number(gapCount.data.total)}${gapCount.data.totalIsExact === false ? "+" : ""}` : common("empty"),
                  tone: gapCount.isSuccess && gapCount.data.total > 0 ? "warning" : undefined,
                  active: tab === "gaps",
                  onPick: () => pick("gaps"),
                },
                {
                  key: "types",
                  label: t("typeCount"),
                  value: types.isSuccess ? types.data.length : common("empty"),
                  active: tab === "types",
                  onPick: () => pick("types"),
                },
              ]}
            />
          </AsideCard>
        }
      >
        {panel()}
      </PageLayout>

      <LayerDialog.Root open={adding} onOpenChange={setAdding} dismissDisabled={create.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("add")}</LayerDialog.Title>
          <LayerDialog.Description>{t("addLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <form
              id="document-add"
              className="grid items-start gap-4 sm:grid-cols-[12rem_1fr]"
              onSubmit={(event) => {
                event.preventDefault();
                setFault(null);
                create.mutate();
              }}
            >
              <Input
                label={t("code")}
                required
                maxLength={64}
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                className="font-mono"
              />
              <Input label={t("docTitle")} required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
            </form>
            {faultBanner}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary type="submit" form="document-add" loading={create.isPending}>
              {t("add")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Root
        open={publishing !== null}
        onOpenChange={(next) => {
          if (!next) {
            setPublishing(null);
          }
        }}
        dismissDisabled={publish.isPending}
      >
        <LayerDialog.Content size="lg" closeLabel={common("close")}>
          <LayerDialog.Title>{publishing ? t("publishTitle", { title: publishing.title }) : t("publish")}</LayerDialog.Title>
          <LayerDialog.Description>
            {publishing ? t("publishLead", { version: (publishing.versions[0]?.version ?? 0) + 1 }) : null}
          </LayerDialog.Description>
          <LayerDialog.Body>
            <form
              id="document-publish"
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (publishing) {
                  setFault(null);
                  publish.mutate(publishing);
                }
              }}
            >
              <Textarea
                label={t("nextVersion")}
                required
                rows={10}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
              <Input
                label={t("summary")}
                description={t("summaryHint")}
                maxLength={240}
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
              />
              <Banner variant="alert" icon={<WarningIcon weight="fill" />} title={t("publishWarning")} />
            </form>
            {faultBanner}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary type="submit" form="document-publish" loading={publish.isPending} disabled={body.trim() === ""}>
              {t("publishN", { version: (publishing?.versions[0]?.version ?? 0) + 1 })}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Root
        open={reading !== null}
        onOpenChange={(next) => {
          if (!next) {
            setReading(null);
          }
        }}
      >
        <LayerDialog.Content size="lg" closeLabel={common("close")}>
          <LayerDialog.Title>{reading ? t("readersOf", { title: reading.title }) : t("whoSigned")}</LayerDialog.Title>
          <LayerDialog.Description>
            {latest ? `${t("versionLine", { version: latest.version })} · ${day(latest.publishedAt)}` : null}
          </LayerDialog.Description>
          <LayerDialog.Body>
            {latest?.summary ? <p className="mb-3">{latest.summary}</p> : null}
            {readers.isError ? (
              <Failed onRetry={() => void readers.refetch()} />
            ) : readers.isPending ? (
              <div className="flex flex-col gap-3">
                {Array.from({ length: 4 }, (_, at) => (
                  <SkeletonLine key={at} minWidth={27} maxWidth={60} />
                ))}
              </div>
            ) : readerRows && readerRows.length > 0 ? (
              <LayerCard className="p-0">
                <ul className="flex flex-col">
                  {readerRows.map((one) => (
                    <li key={one.employeeId} className="flex items-center justify-between gap-3 border-b border-kumo-hairline px-3 py-2 last:border-0">
                      <Link href={`/employees/${one.employeeId}`} className="flex min-w-0 flex-col hover:underline">
                        <span className="truncate">{one.fullName}</span>
                        <span className="font-mono text-sm text-kumo-subtle">{one.code}</span>
                      </Link>
                      <StatePill tone={one.ackAt ? "good" : "waiting"}>
                        {one.ackAt ? t("signedOn", { when: day(one.ackAt) }) : t("unsignedColumn")}
                      </StatePill>
                    </li>
                  ))}
                </ul>
                {firstReaders ? (
                  <PagingRow
                    paging={{
                      shown: readerRows.length,
                      total: firstReaders.total,
                      exact: firstReaders.totalIsExact,
                      onMore: readers.hasNextPage ? () => void readers.fetchNextPage() : undefined,
                      loading: readers.isFetchingNextPage,
                    }}
                  />
                ) : null}
              </LayerCard>
            ) : (
              <Empty size="sm" icon={<UsersIcon size={32} className="text-kumo-inactive" />} title={t("readersNone")} description={t("readersNoneHint")} />
            )}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("close")}>
            <LayerDialog.Actions.Primary onClick={() => reading && openPublish(reading)}>{t("publishNext")}</LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Root open={typing} onOpenChange={setTyping} dismissDisabled={addType.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("addType")}</LayerDialog.Title>
          <LayerDialog.Description>{t("typesLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <form
              id="type-add"
              className="grid items-start gap-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                setFault(null);
                addType.mutate();
              }}
            >
              <Input
                label={t("code")}
                required
                maxLength={64}
                value={typeCode}
                onChange={(event) => setTypeCode(event.target.value.toUpperCase())}
                className="font-mono"
              />
              <Input label={t("typeName")} required maxLength={200} value={typeName} onChange={(event) => setTypeName(event.target.value)} />
              <Input
                label={t("validMonthsField")}
                description={t("validMonthsHint")}
                type="number"
                min={1}
                value={typeMonths}
                onChange={(event) => setTypeMonths(event.target.value)}
                className="tabular-nums"
              />
              <div className="flex items-center pt-6">
                <Checkbox checked={typeRequired} onCheckedChange={(checked) => setTypeRequired(checked === true)} label={t("requiredLabel")} />
              </div>
            </form>
            {faultBanner}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary type="submit" form="type-add" loading={addType.isPending}>
              {t("addType")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}
