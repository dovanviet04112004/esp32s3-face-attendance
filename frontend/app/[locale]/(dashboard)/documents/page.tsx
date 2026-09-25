"use client";

import { Banner, Button, Checkbox, Combobox, Empty, Input, InputGroup, LayerCard, LayerDialog, Select, Textarea } from "@cloudflare/kumo";
import {
  ArrowCounterClockwiseIcon,
  MagnifyingGlassIcon,
  MegaphoneIcon,
  PencilSimpleIcon,
  PlusIcon,
  ProhibitIcon,
  UsersIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { Suspense, useEffect, useState, type ReactNode } from "react";

import { FileGaps } from "@/components/documents/file-gaps";
import { DataTable, PagingRow, PersonCell, type Column, type RowAction } from "@/components/tables/data-table";
import { Failed } from "@/components/ui/failed";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { useNotify } from "@/components/ui/notify";
import { useOptional } from "@/components/ui/optional";
import { PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill } from "@/components/ui/pill";
import { SkeletonLine } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";
import { useUrlState } from "@/lib/url-state";

const TABS = ["publish", "gaps", "types"] as const;
const TAB_KEY = { publish: "tabPublish", gaps: "tabGaps", types: "tabTypes" } as const;
const KINDS = ["POLICY", "HANDBOOK", "NOTICE"] as const;
const kReadersPage = 50;
const kCodeMax = 64;
const kTitleMax = 200;
const kSummaryMax = 240;
const kTypeNameMax = 200;

type Tab = (typeof TABS)[number];
type Kind = (typeof KINDS)[number];

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
  ordinal: number;
  active: boolean;
}

interface Doc {
  id: string;
  code: string;
  title: string;
  kind: Kind;
  departmentId: string | null;
  jobTitleId: string | null;
  active: boolean;
  versions: Version[];
}

interface Named {
  id: string;
  code: string;
  name: string;
}

interface DocDraft {
  held: Doc | null;
  code: string;
  title: string;
  kind: Kind;
  departmentId: string;
  jobTitleId: string;
}

interface TypeDraft {
  held: FileType | null;
  code: string;
  name: string;
  validMonths: string;
  required: boolean;
  ordinal: string;
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

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

/** A searchable pick from a catalogue that can run to hundreds of rows; empty means "every one of them". */
function ChoiceField({
  label,
  description,
  items,
  value,
  onChange,
  none,
  empty,
}: {
  label: ReactNode;
  description?: string;
  items: Named[];
  value: string;
  onChange: (next: string) => void;
  /** The placeholder of the empty field, so the first keystroke already searches. */
  none: string;
  empty: string;
}) {
  const common = useTranslations("common");
  const held = items.find((one) => one.id === value) ?? null;
  return (
    <Combobox
      items={items}
      value={held}
      onValueChange={(next) => onChange((next as Named | null)?.id ?? "")}
      itemToStringLabel={(one: Named) => one.name}
      isItemEqualToValue={(one: Named, other: Named) => one.id === other.id}
      filter={(one: Named, typed: string) => fold(`${one.code} ${one.name}`).includes(fold(typed.trim()))}
      label={label}
      description={description}
    >
      <Combobox.TriggerInput placeholder={none} clearLabel={common("clear")} showOptionsLabel={common("showOptions")} />
      <Combobox.Content>
        <Combobox.Empty>{items.length === 0 ? empty : common("noMatch")}</Combobox.Empty>
        <Combobox.List>
          {(one: Named) => (
            <Combobox.Item key={one.id} value={one}>
              <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                <span className="truncate">{one.name}</span>
                <span className="shrink-0 font-mono text-kumo-subtle">{one.code}</span>
              </span>
            </Combobox.Item>
          )}
        </Combobox.List>
      </Combobox.Content>
    </Combobox>
  );
}

export default function DocumentsPage() {
  return (
    <Suspense>
      <Documents />
    </Suspense>
  );
}

function Documents() {
  const t = useTranslations("documents");
  const shared = useTranslations("catalogues");
  const people = useTranslations("employees");
  const common = useTranslations("common");
  const format = useFormatter();
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();
  const optional = useOptional();

  const [url, setUrl] = useUrlState({ tab: "publish", q: "", kind: "", retired: "" });
  const tab: Tab = (TABS as readonly string[]).includes(url.tab) ? (url.tab as Tab) : "publish";
  const [typed, setTyped] = useState(url.q);
  const settled = useSettled(typed.trim());
  useEffect(() => {
    if (settled !== url.q) {
      setUrl({ q: settled });
    }
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps
  const showRetired = url.retired === "1";

  const [docDraft, setDocDraft] = useState<DocDraft | null>(null);
  const [typeDraft, setTypeDraft] = useState<TypeDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [publishing, setPublishing] = useState<Doc | null>(null);
  const [body, setBody] = useState("");
  const [summary, setSummary] = useState("");
  const [reading, setReading] = useState<Doc | null>(null);
  const [readerTyped, setReaderTyped] = useState("");
  const readerSearch = useSettled(readerTyped.trim());
  const [unsignedOnly, setUnsignedOnly] = useState(false);
  const [retiringDoc, setRetiringDoc] = useState<Doc | null>(null);
  const [retiringType, setRetiringType] = useState<FileType | null>(null);
  const [fault, setFault] = useState<string | null>(null);

  function pick(next: string): void {
    setTyped("");
    setUrl({ tab: next, q: "", kind: "", retired: "" });
  }

  const docs = useQuery({
    queryKey: ["documents", "all"],
    queryFn: async () => (await api.get<Doc[]>("/documents?all=true")).data,
  });

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Named[]>("/departments")).data,
  });

  const jobTitles = useQuery({
    queryKey: ["job-titles"],
    queryFn: async () => (await api.get<Named[]>("/job-titles")).data,
  });

  const published = (docs.data ?? []).filter((doc) => doc.active && doc.versions.length > 0);
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

  const gapCount = useQuery({
    queryKey: ["personnel-files", "gaps", "count"],
    queryFn: async () => (await api.get<{ total: number; totalIsExact?: boolean }>("/personnel-files/gaps?take=1")).data,
  });

  const types = useQuery({
    queryKey: ["personnel-file-types", "all"],
    queryFn: async () => (await api.get<FileType[]>("/personnel-file-types?all=true")).data,
  });

  const readerQuery = new URLSearchParams({
    take: String(kReadersPage),
    ...(readerSearch ? { search: readerSearch } : {}),
    ...(unsignedOnly ? { unsigned: "true" } : {}),
  }).toString();
  const readers = useInfiniteQuery({
    queryKey: ["documents", reading?.id, "readers", "list", readerQuery],
    enabled: reading !== null,
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const after = pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : "";
      return (await api.get<ReaderPage>(`/documents/${reading?.id}/readers?${readerQuery}${after}`)).data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

  function openPublish(doc: Doc): void {
    setFault(null);
    setTried(false);
    setBody("");
    setSummary("");
    setReading(null);
    setPublishing(doc);
  }

  function openReaders(doc: Doc): void {
    setReaderTyped("");
    setUnsignedOnly(false);
    setReading(doc);
  }

  function refreshDocs(): void {
    void cache.invalidateQueries({ queryKey: ["documents"] });
  }

  const saveDoc = useMutation({
    mutationFn: async (held: DocDraft) => {
      const body = {
        title: held.title.trim(),
        kind: held.kind,
        departmentId: held.departmentId || null,
        jobTitleId: held.jobTitleId || null,
      };
      if (held.held) {
        return (await api.patch<Doc>(`/documents/${held.held.id}`, body)).data;
      }
      return (
        await api.post<Doc>("/documents", {
          code: held.code.trim(),
          title: body.title,
          kind: body.kind,
          ...(body.departmentId ? { departmentId: body.departmentId } : {}),
          ...(body.jobTitleId ? { jobTitleId: body.jobTitleId } : {}),
        })
      ).data;
    },
    onSuccess: (saved, held) => {
      setDocDraft(null);
      refreshDocs();
      if (held.held) {
        notify.done(t("docSavedToast", { title: saved.title }));
        return;
      }
      notify.done(t("addedToast", { code: saved.code }));
      openPublish({ ...saved, versions: [] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const flipDoc = useMutation({
    mutationFn: async (doc: Doc) => (await api.patch<Doc>(`/documents/${doc.id}`, { active: !doc.active })).data,
    onSuccess: (saved) => {
      setRetiringDoc(null);
      notify.done(t(saved.active ? "docRestoredToast" : "docRetiredToast", { title: saved.title }));
      refreshDocs();
    },
    onError: (fell: unknown, doc) => (doc.active ? setFault(faultOf(fell)) : notify.failed(fell)),
  });

  const publish = useMutation({
    mutationFn: async (doc: Doc) =>
      (await api.post<Version>(`/documents/${doc.id}/versions`, { body, summary: summary.trim() || undefined })).data,
    onSuccess: (made, doc) => {
      setPublishing(null);
      notify.done(t("publishedToast", { version: made.version, title: doc.title }));
      refreshDocs();
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function refreshTypes(): void {
    void cache.invalidateQueries({ queryKey: ["personnel-file-types"] });
    void cache.invalidateQueries({ queryKey: ["personnel-files"] });
  }

  const saveType = useMutation({
    mutationFn: async (held: TypeDraft) => {
      const body = {
        name: held.name.trim(),
        required: held.required,
        validMonths: held.validMonths ? Number(held.validMonths) : null,
        ordinal: held.ordinal ? Number(held.ordinal) : 0,
      };
      if (held.held) {
        return (await api.patch<FileType>(`/personnel-file-types/${held.held.id}`, body)).data;
      }
      return (
        await api.post<FileType>("/personnel-file-types", {
          ...body,
          code: held.code.trim(),
          validMonths: body.validMonths ?? undefined,
        })
      ).data;
    },
    onSuccess: (saved, held) => {
      setTypeDraft(null);
      notify.done(t(held.held ? "typeSavedToast" : "typeAddedToast", { name: saved.name }));
      refreshTypes();
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const flipType = useMutation({
    mutationFn: async (one: FileType) =>
      (await api.patch<FileType>(`/personnel-file-types/${one.id}`, { active: !one.active })).data,
    onSuccess: (saved) => {
      setRetiringType(null);
      notify.done(t(saved.active ? "typeRestoredToast" : "typeRetiredToast", { name: saved.name }));
      refreshTypes();
    },
    onError: (fell: unknown, one) => (one.active ? setFault(faultOf(fell)) : notify.failed(fell)),
  });

  function openDoc(doc: Doc | null): void {
    setFault(null);
    setTried(false);
    setDocDraft({
      held: doc,
      code: doc?.code ?? "",
      title: doc?.title ?? "",
      kind: doc?.kind ?? "POLICY",
      departmentId: doc?.departmentId ?? "",
      jobTitleId: doc?.jobTitleId ?? "",
    });
  }

  function submitDoc(held: DocDraft): void {
    setTried(true);
    if (held.title.trim() === "" || (held.held === null && held.code.trim() === "")) {
      return;
    }
    setFault(null);
    saveDoc.mutate(held);
  }

  function openType(one: FileType | null): void {
    setFault(null);
    setTried(false);
    setTypeDraft({
      held: one,
      code: one?.code ?? "",
      name: one?.name ?? "",
      validMonths: one?.validMonths ? String(one.validMonths) : "",
      required: one?.required ?? true,
      ordinal: one ? String(one.ordinal) : "",
    });
  }

  function submitType(held: TypeDraft): void {
    setTried(true);
    if (held.name.trim() === "" || (held.held === null && held.code.trim() === "")) {
      return;
    }
    setFault(null);
    saveType.mutate(held);
  }

  const day = (iso: string) => format.dateTime(new Date(iso), "day");
  const needle = fold(url.q);
  const departmentName = new Map((departments.data ?? []).map((one) => [one.id, one.name]));
  const titleName = new Map((jobTitles.data ?? []).map((one) => [one.id, one.name]));

  function audienceOf(doc: Doc): string {
    const parts = [
      doc.departmentId ? (departmentName.get(doc.departmentId) ?? common("empty")) : null,
      doc.jobTitleId ? (titleName.get(doc.jobTitleId) ?? common("empty")) : null,
    ].filter((one): one is string => one !== null);
    return parts.length > 0 ? parts.join(" · ") : t("everybody");
  }

  const inScope = (docs.data ?? []).filter(
    (doc) => (showRetired || doc.active) && (needle === "" || fold(`${doc.code} ${doc.title}`).includes(needle)),
  );
  const kindCounts = Object.fromEntries(KINDS.map((one) => [one, inScope.filter((doc) => doc.kind === one).length]));
  const shownDocs = docs.data ? inScope.filter((doc) => url.kind === "" || doc.kind === url.kind) : undefined;
  const shownTypes = types.data?.filter(
    (one) => (showRetired || one.active) && (needle === "" || fold(`${one.code} ${one.name}`).includes(needle)),
  );
  const stateColumn = <T extends { active: boolean }>(): Column<T> => ({
    id: "state",
    header: shared("status"),
    cell: (row) => <StatePill tone={row.active ? "good" : "idle"}>{row.active ? shared("active") : shared("retired")}</StatePill>,
  });

  const docColumns: Column<Doc>[] = [
    { id: "title", header: t("docTitle"), cell: (row) => <PersonCell name={row.title} code={row.code} /> },
    { id: "kind", header: t("kind"), priority: 3, cell: (row) => t(`kind_${row.kind}`) },
    { id: "audience", header: t("audience"), priority: 3, truncate: true, cell: (row) => audienceOf(row) },
    {
      id: "version",
      header: t("version"),
      priority: 2,
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
      priority: 2,
      cell: (row) => {
        const seen = signingOf.get(row.id);
        return seen ? seen.reach : common("empty");
      },
    },
    ...(showRetired ? [stateColumn<Doc>()] : []),
  ];

  const typeColumns: Column<FileType>[] = [
    { id: "type", header: t("typeName"), cell: (row) => <PersonCell name={row.name} code={row.code} /> },
    {
      id: "required",
      header: t("requiredColumn"),
      cell: (row) => (row.required ? <StatePill tone="waiting">{t("requiredMark")}</StatePill> : <StatePill>{t("optionalMark")}</StatePill>),
    },
    {
      id: "valid",
      header: t("validMonthsField"),
      priority: 2,
      cell: (row) => (row.validMonths ? t("validMonths", { count: row.validMonths }) : t("noExpiry")),
    },
    { id: "ordinal", header: t("ordinal"), numeric: true, priority: 3, cell: (row) => row.ordinal },
    ...(showRetired ? [stateColumn<FileType>()] : []),
  ];

  function docActions(row: Doc): RowAction[] {
    const actions: RowAction[] = [];
    if (row.versions.length > 0) {
      actions.push({ key: "readers", label: t("whoSigned"), icon: UsersIcon, onSelect: () => openReaders(row) });
    }
    if (row.active) {
      actions.push({ key: "publish", label: t("publishNext"), icon: MegaphoneIcon, onSelect: () => openPublish(row) });
    }
    actions.push({ key: "edit", label: shared("edit"), icon: PencilSimpleIcon, onSelect: () => openDoc(row) });
    actions.push(
      row.active
        ? {
            key: "retire",
            label: shared("retire"),
            icon: ProhibitIcon,
            danger: true,
            onSelect: () => {
              setFault(null);
              setRetiringDoc(row);
            },
          }
        : { key: "restore", label: shared("restore"), icon: ArrowCounterClockwiseIcon, onSelect: () => flipDoc.mutate(row) },
    );
    return actions;
  }

  function typeActions(row: FileType): RowAction[] {
    return [
      { key: "edit", label: shared("edit"), icon: PencilSimpleIcon, onSelect: () => openType(row) },
      row.active
        ? {
            key: "retire",
            label: shared("retire"),
            icon: ProhibitIcon,
            danger: true,
            onSelect: () => {
              setFault(null);
              setRetiringType(row);
            },
          }
        : { key: "restore", label: shared("restore"), icon: ArrowCounterClockwiseIcon, onSelect: () => flipType.mutate(row) },
    ];
  }

  const faultBanner = fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} className="mt-4" /> : null;
  const readerRows = readers.data?.pages.flatMap((one) => one.rows);
  const firstReaders = readers.data?.pages[0];
  const latest = reading?.versions[0];
  const retiredToggle = (
    <Checkbox
      label={shared("showRetired")}
      checked={showRetired}
      onCheckedChange={(next) => setUrl({ retired: next === true ? "1" : "" })}
    />
  );

  const actions =
    tab === "publish" ? (
      <Button variant="primary" icon={PlusIcon} onClick={() => openDoc(null)}>
        {t("add")}
      </Button>
    ) : tab === "types" ? (
      <Button variant="primary" icon={PlusIcon} onClick={() => openType(null)}>
        {t("addType")}
      </Button>
    ) : undefined;

  function panel() {
    if (tab === "gaps") {
      return (
        <div className="flex flex-col gap-3">
          <p className="text-kumo-subtle">{t("gapsLead")}</p>
          <FileGaps
            declared={types.data ? types.data.some((one) => one.active && one.required) : undefined}
            onDeclare={() => {
              pick("types");
              openType(null);
            }}
          />
        </div>
      );
    }
    if (tab === "types") {
      return (
        <div className="flex flex-col gap-3">
          <p className="text-kumo-subtle">{t("typesLead")}</p>
          <FilterBar search={{ value: typed, onChange: setTyped, placeholder: shared("searchHint") }} extra={retiredToggle} />
          <DataTable
            id="file-types"
            cardLead="type"
            cardTrailing="required"
            columns={typeColumns}
            rows={shownTypes}
            keyOf={(row) => row.id}
            pending={types.isPending}
            failed={types.isError}
            onRetry={() => void types.refetch()}
            onRowClick={openType}
            rowActions={typeActions}
            empty={url.q ? shared("noMatch") : t("typesEmptyTitle")}
            emptyHint={url.q ? undefined : t("typesEmpty")}
            emptyAction={
              url.q ? undefined : (
                <Button variant="secondary" icon={PlusIcon} onClick={() => openType(null)}>
                  {t("addType")}
                </Button>
              )
            }
          />
        </div>
      );
    }
    return (
      <>
        <FilterBar
          search={{ value: typed, onChange: setTyped, placeholder: t("searchHint") }}
          filters={[
            {
              key: "kind",
              label: t("kind"),
              value: url.kind,
              onChange: (next) => setUrl({ kind: next }),
              items: { "": t("anyKind"), ...Object.fromEntries(KINDS.map((one) => [one, t(`kind_${one}`)])) },
              counts: docs.data ? { "": inScope.length, ...kindCounts } : undefined,
            },
          ]}
          extra={retiredToggle}
        />
        <DataTable
          id="documents"
          cardLead="title"
          cardTrailing="unsigned"
          columns={docColumns}
          rows={shownDocs}
          keyOf={(row) => row.id}
          pending={docs.isPending}
          failed={docs.isError}
          onRetry={() => void docs.refetch()}
          empty={url.q || url.kind ? t("noneInFilter") : t("none")}
          emptyHint={url.q || url.kind ? undefined : t("noneHint")}
          emptyAction={
            url.q || url.kind ? undefined : (
              <Button variant="secondary" icon={PlusIcon} onClick={() => openDoc(null)}>
                {t("add")}
              </Button>
            )
          }
          onRowClick={(row) => (row.versions.length > 0 ? openReaders(row) : row.active ? openPublish(row) : openDoc(row))}
          rowActions={docActions}
        />
      </>
    );
  }

  const gapsLabel = gapCount.data && gapCount.data.total > 0
    ? `${t("tabGaps")} · ${format.number(gapCount.data.total)}${gapCount.data.totalIsExact === false ? "+" : ""}`
    : t("tabGaps");

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("lead")}
        actions={actions}
        tabs={TABS.map((one) => ({ value: one, label: one === "gaps" ? gapsLabel : t(TAB_KEY[one]) }))}
        tab={tab}
        onTab={pick}
      />

      <PageLayout>{panel()}</PageLayout>

      <LayerDialog.Root open={docDraft !== null} onOpenChange={(next) => !next && setDocDraft(null)} dismissDisabled={saveDoc.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{docDraft?.held ? t("editDocTitle", { code: docDraft.held.code }) : t("add")}</LayerDialog.Title>
          <LayerDialog.Description>{docDraft?.held ? t("editDocLead") : t("addLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            {docDraft ? (
              <div className="grid items-start gap-4 sm:grid-cols-2">
                {docDraft.held === null ? (
                  <Input
                    label={t("code")}
                    required
                    maxLength={kCodeMax}
                    value={docDraft.code}
                    error={tried && docDraft.code.trim() === "" ? common("required") : undefined}
                    onChange={(event) => setDocDraft({ ...docDraft, code: event.target.value.toUpperCase() })}
                    className="font-mono"
                  />
                ) : null}
                <div className={docDraft.held === null ? undefined : "sm:col-span-2"}>
                  <Input
                    label={t("docTitle")}
                    required
                    maxLength={kTitleMax}
                    value={docDraft.title}
                    error={tried && docDraft.title.trim() === "" ? common("required") : undefined}
                    onChange={(event) => setDocDraft({ ...docDraft, title: event.target.value })}
                  />
                </div>
                <Select
                  label={t("kind")}
                  className="w-full"
                  value={docDraft.kind}
                  onValueChange={(next) => setDocDraft({ ...docDraft, kind: (String(next ?? "POLICY") as Kind) })}
                  items={Object.fromEntries(KINDS.map((one) => [one, t(`kind_${one}`)]))}
                />
                <div className="sm:col-span-2">
                  <ChoiceField
                    label={optional(t("audienceDepartment"))}
                    items={departments.data ?? []}
                    value={docDraft.departmentId}
                    onChange={(next) => setDocDraft({ ...docDraft, departmentId: next })}
                    none={t("anyDepartment")}
                    empty={people("departmentsEmpty")}
                  />
                </div>
                <div className="sm:col-span-2">
                  <ChoiceField
                    label={optional(t("audienceJobTitle"))}
                    description={t("audienceHint")}
                    items={jobTitles.data ?? []}
                    value={docDraft.jobTitleId}
                    onChange={(next) => setDocDraft({ ...docDraft, jobTitleId: next })}
                    none={t("anyJobTitle")}
                    empty={people("jobTitlesEmpty")}
                  />
                </div>
                <div className="sm:col-span-2">{faultBanner}</div>
              </div>
            ) : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary loading={saveDoc.isPending} onClick={() => docDraft && submitDoc(docDraft)}>
              {docDraft?.held ? common("save") : t("add")}
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
                setTried(true);
                if (publishing && body.trim() !== "") {
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
                error={tried && body.trim() === "" ? common("required") : undefined}
                onChange={(event) => setBody(event.target.value)}
              />
              <Input
                label={optional(t("summary"))}
                description={t("summaryHint")}
                maxLength={kSummaryMax}
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
              />
              <Banner variant="alert" icon={<WarningIcon weight="fill" />} title={t("publishWarning")} />
            </form>
            {faultBanner}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary type="submit" form="document-publish" loading={publish.isPending}>
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
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <InputGroup className="min-w-0 flex-1 basis-56">
                <InputGroup.Addon>
                  <MagnifyingGlassIcon />
                </InputGroup.Addon>
                <InputGroup.Input
                  type="search"
                  value={readerTyped}
                  placeholder={t("readerSearchHint")}
                  aria-label={t("readerSearchHint")}
                  onChange={(event) => setReaderTyped(event.target.value)}
                />
              </InputGroup>
              <Checkbox
                label={t("unsignedOnly")}
                checked={unsignedOnly}
                onCheckedChange={(next) => setUnsignedOnly(next === true)}
              />
            </div>
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
            ) : readerSearch || unsignedOnly ? (
              <Empty size="sm" icon={<UsersIcon size={32} className="text-kumo-inactive" />} title={t("readersNoMatch")} />
            ) : (
              <Empty size="sm" icon={<UsersIcon size={32} className="text-kumo-inactive" />} title={t("readersNone")} description={t("readersNoneHint")} />
            )}
          </LayerDialog.Body>
          {reading?.active ? (
            <LayerDialog.Actions dismissLabel={common("close")}>
              <LayerDialog.Actions.Primary onClick={() => openPublish(reading)}>{t("publishNext")}</LayerDialog.Actions.Primary>
            </LayerDialog.Actions>
          ) : null}
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Root open={typeDraft !== null} onOpenChange={(next) => !next && setTypeDraft(null)} dismissDisabled={saveType.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{typeDraft?.held ? t("editTypeTitle", { code: typeDraft.held.code }) : t("addType")}</LayerDialog.Title>
          <LayerDialog.Description>{typeDraft?.held ? t("editTypeLead") : t("typesLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            {typeDraft ? (
              <div className="grid items-start gap-4 sm:grid-cols-2">
                {typeDraft.held === null ? (
                  <Input
                    label={t("code")}
                    required
                    maxLength={kCodeMax}
                    value={typeDraft.code}
                    error={tried && typeDraft.code.trim() === "" ? common("required") : undefined}
                    onChange={(event) => setTypeDraft({ ...typeDraft, code: event.target.value.toUpperCase() })}
                    className="font-mono"
                  />
                ) : null}
                <div className={typeDraft.held === null ? undefined : "sm:col-span-2"}>
                  <Input
                    label={t("typeName")}
                    required
                    maxLength={kTypeNameMax}
                    value={typeDraft.name}
                    error={tried && typeDraft.name.trim() === "" ? common("required") : undefined}
                    onChange={(event) => setTypeDraft({ ...typeDraft, name: event.target.value })}
                  />
                </div>
                <Input
                  label={optional(t("validMonthsField"))}
                  description={t("validMonthsHint")}
                  type="number"
                  min={1}
                  value={typeDraft.validMonths}
                  onChange={(event) => setTypeDraft({ ...typeDraft, validMonths: event.target.value })}
                  className="tabular-nums"
                />
                <Input
                  label={optional(t("ordinal"))}
                  description={t("ordinalHint")}
                  type="number"
                  min={0}
                  value={typeDraft.ordinal}
                  onChange={(event) => setTypeDraft({ ...typeDraft, ordinal: event.target.value })}
                  className="tabular-nums"
                />
                <div className="sm:col-span-2">
                  <Checkbox
                    checked={typeDraft.required}
                    onCheckedChange={(checked) => setTypeDraft({ ...typeDraft, required: checked === true })}
                    label={t("requiredLabel")}
                  />
                </div>
                <div className="sm:col-span-2">{faultBanner}</div>
              </div>
            ) : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary loading={saveType.isPending} onClick={() => typeDraft && submitType(typeDraft)}>
              {typeDraft?.held ? common("save") : t("addType")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Alert open={retiringDoc !== null} onOpenChange={(next) => !next && setRetiringDoc(null)} dismissDisabled={flipDoc.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{retiringDoc ? t("retireDocTitle", { title: retiringDoc.title }) : shared("retire")}</LayerDialog.Title>
          <LayerDialog.Description>{t("retireDocLead")}</LayerDialog.Description>
          <LayerDialog.Body>{faultBanner}</LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary variant="destructive" loading={flipDoc.isPending} onClick={() => retiringDoc && flipDoc.mutate(retiringDoc)}>
              {shared("retire")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>

      <LayerDialog.Alert open={retiringType !== null} onOpenChange={(next) => !next && setRetiringType(null)} dismissDisabled={flipType.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{retiringType ? t("retireTypeTitle", { name: retiringType.name }) : shared("retire")}</LayerDialog.Title>
          <LayerDialog.Description>{t("retireTypeLead")}</LayerDialog.Description>
          <LayerDialog.Body>{faultBanner}</LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary variant="destructive" loading={flipType.isPending} onClick={() => retiringType && flipType.mutate(retiringType)}>
              {shared("retire")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </>
  );
}
