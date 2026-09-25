"use client";

import { Banner, Button, Combobox, Input, LayerDialog, Select } from "@cloudflare/kumo";
import {
  ArrowCounterClockwiseIcon,
  CheckIcon,
  PlusIcon,
  ProhibitIcon,
  TrashIcon,
  UserIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";

import { DataTable, PersonCell, type Column } from "@/components/tables/data-table";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { useOptional } from "@/components/ui/optional";
import { AsideCard, PageHeader, PageLayout } from "@/components/ui/page";
import { CountPill, StatePill } from "@/components/ui/pill";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { dayOnly, todayIso } from "@/lib/format";
import { useUrlState } from "@/lib/url-state";

const FINISHERS = ["ADMIN", "HR", "MANAGER"];
const MANAGERS_OF_TEMPLATES = ["ADMIN", "HR"];
const KINDS = ["ONBOARDING", "OFFBOARDING"] as const;
const OWNERS = ["HR", "MANAGER", "SELF"] as const;
const kMaxItems = 100;
const kNameMax = 160;
const kItemMax = 200;
const kDayWindow = 365;

type Kind = (typeof KINDS)[number];
type Owner = (typeof OWNERS)[number];

interface Named {
  id: string;
  code: string;
  name: string;
}

interface Choice {
  value: string;
  label: string;
}

interface TaskPage {
  rows: OpenTask[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
}

interface OpenCounts {
  open: number;
  overdue: number;
  owners: Record<Owner, number>;
}

interface OpenTask {
  id: string;
  title: string;
  ownerRole: Owner;
  dueOn: string;
  run: {
    kind: Kind;
    employee: { id: number; code: string; fullName: string };
  };
}

interface Template {
  id: string;
  kind: Kind;
  name: string;
  jobTitleId: string | null;
  departmentId: string | null;
  jobTitle: Named | null;
  department: Named | null;
  active: boolean;
  items: { title: string; owner: Owner; dueDays: number }[];
}

interface ItemDraft {
  key: number;
  title: string;
  owner: Owner;
  dueDays: string;
}

interface TemplateDraft {
  held: Template | null;
  name: string;
  kind: Kind;
  jobTitleId: string;
  departmentId: string;
  items: ItemDraft[];
}

function isLate(task: OpenTask): boolean {
  return task.dueOn.slice(0, 10) < todayIso();
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

function dueOk(value: string): boolean {
  const days = Number(value);
  return value !== "" && Number.isInteger(days) && Math.abs(days) <= kDayWindow;
}

/** A searchable pick from a catalogue that can run to hundreds of rows. */
function ChoiceField({
  label,
  items,
  value,
  onChange,
  none,
}: {
  label: ReactNode;
  items: Named[];
  value: string;
  onChange: (next: string) => void;
  none: string;
}) {
  const common = useTranslations("common");
  const choices = useMemo(
    () => [{ value: "", label: none }, ...items.map((one): Choice => ({ value: one.id, label: `${one.code} · ${one.name}` }))],
    [items, none],
  );
  const held = choices.find((one) => one.value === value) ?? choices[0];
  return (
    <Combobox
      items={choices}
      value={held}
      onValueChange={(next) => onChange((next as Choice | null)?.value ?? "")}
      itemToStringLabel={(one: Choice) => one.label}
      isItemEqualToValue={(one: Choice, other: Choice) => one.value === other.value}
      filter={(one: Choice, typed: string) => fold(one.label).includes(fold(typed.trim()))}
      label={label}
    >
      <Combobox.TriggerInput placeholder={common("search")} clearLabel={common("clear")} showOptionsLabel={common("showOptions")} />
      <Combobox.Content>
        <Combobox.Empty>{common("noMatch")}</Combobox.Empty>
        <Combobox.List>
          {(one: Choice) => (
            <Combobox.Item key={one.value} value={one}>
              {one.label}
            </Combobox.Item>
          )}
        </Combobox.List>
      </Combobox.Content>
    </Combobox>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense>
      <Onboarding />
    </Suspense>
  );
}

function Onboarding() {
  const t = useTranslations("onboarding");
  const shared = useTranslations("catalogues");
  const common = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const cache = useQueryClient();
  const role = useSession((s) => s.role);
  const faultOf = useFault();
  const notify = useNotify();
  const optional = useOptional();
  const mayFinish = role !== null && FINISHERS.includes(role);
  const mayManage = role !== null && MANAGERS_OF_TEMPLATES.includes(role);

  const [url, setUrl] = useUrlState({ q: "", kind: "", owner: "", pick: "", dept: "" });
  const [typed, setTyped] = useState(url.q);
  const settled = useSettled(typed.trim());
  useEffect(() => {
    if (settled !== url.q) {
      setUrl({ q: settled });
    }
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps

  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [retiring, setRetiring] = useState<Template | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const [nextKey, setNextKey] = useState(0);
  const [fault, setFault] = useState<string | null>(null);

  const narrowing = new URLSearchParams({
    ...(url.kind ? { kind: url.kind } : {}),
    ...(url.q ? { search: url.q } : {}),
    ...(url.dept ? { departmentId: url.dept } : {}),
  }).toString();

  const tasks = useInfiniteQuery({
    queryKey: ["checklists", "open", narrowing, url.owner, url.pick],
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams(narrowing);
      if (url.pick === "late") {
        params.set("overdue", "true");
      }
      if (url.owner) {
        params.set("owner", url.owner);
      }
      if (pageParam) {
        params.set("cursor", pageParam);
      }
      return (await api.get<TaskPage>(`/checklists/open?${params.toString()}`)).data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const counts = useQuery({
    queryKey: ["checklists", "open", "counts", narrowing],
    queryFn: async () => (await api.get<OpenCounts>(`/checklists/open/counts${narrowing ? `?${narrowing}` : ""}`)).data,
  });

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Named[]>("/departments")).data,
  });

  const jobTitles = useQuery({
    queryKey: ["job-titles"],
    enabled: mayManage,
    queryFn: async () => (await api.get<Named[]>("/job-titles")).data,
  });

  const templates = useQuery({
    queryKey: ["checklist-templates", "all"],
    enabled: mayManage,
    queryFn: async () => (await api.get<Template[]>("/checklist-templates?all=true")).data,
  });

  const finish = useMutation({
    mutationFn: async (task: OpenTask) => {
      await api.post(`/checklist-tasks/${task.id}/finish`, {});
      return task;
    },
    onSuccess: (task) => {
      notify.done(t("finished", { title: task.title }));
      void cache.invalidateQueries({ queryKey: ["checklists"] });
      void cache.invalidateQueries({ queryKey: ["checklist", task.run.employee.id] });
    },
    onError: notify.failed,
  });

  const save = useMutation({
    mutationFn: async (held: TemplateDraft) => {
      const body = {
        name: held.name.trim(),
        jobTitleId: held.jobTitleId || null,
        departmentId: held.departmentId || null,
        items: held.items.map((one) => ({ title: one.title.trim(), owner: one.owner, dueDays: Number(one.dueDays) })),
      };
      if (held.held) {
        return (await api.patch<Template>(`/checklist-templates/${held.held.id}`, body)).data;
      }
      return (await api.post<Template>("/checklist-templates", { ...body, kind: held.kind })).data;
    },
    onSuccess: (saved, held) => {
      setDraft(null);
      notify.done(t(held.held ? "templateSaved" : "templateAdded", { name: saved.name }));
      void cache.invalidateQueries({ queryKey: ["checklist-templates"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const flip = useMutation({
    mutationFn: async (one: Template) =>
      (await api.patch<Template>(`/checklist-templates/${one.id}`, { active: !one.active })).data,
    onSuccess: (saved) => {
      setRetiring(null);
      setDraft(null);
      notify.done(t(saved.active ? "templateRestored" : "templateRetired", { name: saved.name }));
      void cache.invalidateQueries({ queryKey: ["checklist-templates"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function blankItem(key: number): ItemDraft {
    return { key, title: "", owner: "HR", dueDays: "0" };
  }

  function openTemplate(one: Template | null): void {
    setFault(null);
    setTried(false);
    const items = one ? one.items.map((item, at) => ({ key: at, title: item.title, owner: item.owner, dueDays: String(item.dueDays) })) : [blankItem(0), blankItem(1)];
    setNextKey(items.length);
    setDraft({
      held: one,
      name: one?.name ?? "",
      kind: one?.kind ?? "ONBOARDING",
      jobTitleId: one?.jobTitleId ?? "",
      departmentId: one?.departmentId ?? "",
      items,
    });
  }

  function patchItem(key: number, patch: Partial<ItemDraft>): void {
    setDraft((held) => (held ? { ...held, items: held.items.map((one) => (one.key === key ? { ...one, ...patch } : one)) } : held));
  }

  function submit(held: TemplateDraft): void {
    setTried(true);
    if (held.name.trim() === "" || held.items.length === 0 || held.items.some((one) => one.title.trim() === "" || !dueOk(one.dueDays))) {
      return;
    }
    setFault(null);
    save.mutate(held);
  }

  const rows = tasks.data?.pages.flatMap((one) => one.rows);
  const first = tasks.data?.pages[0];
  const live = (templates.data ?? []).filter((one) => one.active);
  const retired = (templates.data ?? []).filter((one) => !one.active);
  const noTemplates = templates.isSuccess && live.length === 0;

  const columns: Column<OpenTask>[] = [
    { id: "title", header: t("task"), truncate: true, cell: (row) => row.title },
    {
      id: "employee",
      header: t("person"),
      cell: (row) => <PersonCell name={row.run.employee.fullName} code={row.run.employee.code} />,
    },
    {
      id: "due",
      header: t("due"),
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="tabular-nums">{format.dateTime(dayOnly(row.dueOn), "day")}</span>
          {isLate(row) ? <StatePill tone="bad">{t("overdue")}</StatePill> : null}
        </span>
      ),
    },
    { id: "kind", header: t("kind"), priority: 3, cell: (row) => t(`kind${row.run.kind}`) },
    { id: "owner", header: t("owner"), priority: 2, cell: (row) => t(`owner${row.ownerRole}`) },
  ];

  const filtered = Object.values(url).some((value) => value !== "");

  function templateRow(one: Template) {
    const scope = [one.jobTitle?.name, one.department?.name].filter(Boolean).join(" · ");
    return (
      <li key={one.id}>
        <button
          type="button"
          onClick={() => openTemplate(one)}
          className="flex min-h-9 w-full items-center justify-between gap-3 rounded-md px-2 text-start hover:bg-kumo-tint pointer-coarse:min-h-11"
        >
          <span className="flex min-w-0 flex-col py-1">
            <span className={one.active ? "truncate" : "truncate text-kumo-subtle"}>{one.name}</span>
            <span className="truncate text-sm text-kumo-subtle">
              {t(`kind${one.kind}`)} · {scope || t("everyone")}
            </span>
          </span>
          <CountPill>{t("itemCount", { count: one.items.length })}</CountPill>
        </button>
      </li>
    );
  }

  return (
    <>
      <PageHeader title={t("title")} description={t("lead")} />

      <PageLayout
        aside={
          mayManage ? (
            <AsideCard
              title={t("templatesTitle")}
              action={
                <Button variant="ghost" size="sm" icon={PlusIcon} onClick={() => openTemplate(null)}>
                  {t("templateAdd")}
                </Button>
              }
            >
              {templates.isError ? (
                <Failed onRetry={() => void templates.refetch()} />
              ) : templates.isSuccess && live.length === 0 ? (
                <p className="text-kumo-subtle">{t("templatesEmpty")}</p>
              ) : (
                <ul className="-mx-2 -my-1 flex flex-col">{live.map(templateRow)}</ul>
              )}
              {retired.length > 0 ? (
                <div className="mt-3 flex flex-col gap-1 border-t border-kumo-hairline pt-3">
                  <Button variant="ghost" size="sm" className="self-start" onClick={() => setShowRetired(!showRetired)}>
                    {showRetired ? t("hideRetired") : t("showRetired", { count: retired.length })}
                  </Button>
                  {showRetired ? <ul className="-mx-2 flex flex-col">{retired.map(templateRow)}</ul> : null}
                </div>
              ) : null}
            </AsideCard>
          ) : undefined
        }
      >
        <FilterBar
          search={{ value: typed, onChange: setTyped, placeholder: t("searchHint") }}
          filters={[
            {
              key: "kind",
              label: t("kind"),
              value: url.kind,
              onChange: (next) => setUrl({ kind: next }),
              items: { "": t("anyKind"), ONBOARDING: t("kindONBOARDING"), OFFBOARDING: t("kindOFFBOARDING") },
            },
            {
              key: "owner",
              label: t("owner"),
              value: url.owner,
              onChange: (next) => setUrl({ owner: next }),
              items: { "": t("anyOwner"), ...Object.fromEntries(OWNERS.map((owner) => [owner, t(`owner${owner}`)])) },
              counts: counts.data ? { "": counts.data.open, ...counts.data.owners } : undefined,
            },
            {
              key: "due",
              label: t("due"),
              value: url.pick,
              onChange: (next) => setUrl({ pick: next }),
              items: { "": t("anyDue"), late: t("overdue") },
              counts: counts.data ? { "": counts.data.open, late: counts.data.overdue } : undefined,
            },
            {
              key: "department",
              label: t("department"),
              value: url.dept,
              searchable: true,
              onChange: (next) => setUrl({ dept: next }),
              items: {
                "": t("anyDepartment"),
                ...Object.fromEntries((departments.data ?? []).map((one) => [one.id, `${one.code} · ${one.name}`])),
              },
            },
          ]}
        />
        <DataTable
          id="onboarding-open"
          cardLead="title"
          columns={columns}
          rows={rows}
          keyOf={(row) => row.id}
          pending={tasks.isPending}
          failed={tasks.isError}
          onRetry={() => void tasks.refetch()}
          empty={filtered ? t("noMatch") : noTemplates ? t("noTemplates") : t("allDone")}
          emptyHint={filtered ? t("noMatchHint") : noTemplates ? t("noTemplatesHint") : t("allDoneHint")}
          emptyAction={
            !filtered && noTemplates && mayManage ? (
              <Button variant="primary" icon={PlusIcon} onClick={() => openTemplate(null)}>
                {t("templateAdd")}
              </Button>
            ) : undefined
          }
          rowHref={(row) => `/employees/${row.run.employee.id}?tab=checklist`}
          rowActions={(row) => [
            ...(mayFinish
              ? [{ key: "finish", label: t("finish"), icon: CheckIcon, disabled: finish.isPending, onSelect: () => finish.mutate(row) }]
              : []),
            {
              key: "open",
              label: t("openProfile"),
              icon: UserIcon,
              onSelect: () => router.push(`/employees/${row.run.employee.id}?tab=checklist`),
            },
          ]}
          paging={
            first
              ? {
                  shown: rows?.length ?? 0,
                  total: first.total,
                  exact: first.totalIsExact,
                  onMore: tasks.hasNextPage ? () => void tasks.fetchNextPage() : undefined,
                  loading: tasks.isFetchingNextPage,
                }
              : undefined
          }
        />
      </PageLayout>

      <LayerDialog.Root open={draft !== null} onOpenChange={(next) => !next && setDraft(null)} dismissDisabled={save.isPending}>
        <LayerDialog.Content size="lg" closeLabel={common("close")}>
          <LayerDialog.Title>{draft?.held ? t("templateEditTitle", { name: draft.held.name }) : t("templateAdd")}</LayerDialog.Title>
          <LayerDialog.Description>{t("templatesLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            {draft ? (
              <div className="flex flex-col gap-4">
                {draft.held && !draft.held.active ? (
                  <span>
                    <StatePill>{shared("retired")}</StatePill>
                  </span>
                ) : null}
                <div className="grid items-start gap-4 sm:grid-cols-[1fr_12rem]">
                  <Input
                    label={t("templateName")}
                    required
                    maxLength={kNameMax}
                    value={draft.name}
                    error={tried && draft.name.trim() === "" ? common("required") : undefined}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                  {draft.held === null ? (
                    <Select
                      label={t("kind")}
                      hideLabel={false}
                      value={draft.kind}
                      onValueChange={(next) => setDraft({ ...draft, kind: String(next ?? "ONBOARDING") as Kind })}
                      items={{ ONBOARDING: t("kindONBOARDING"), OFFBOARDING: t("kindOFFBOARDING") }}
                      className="w-full"
                    />
                  ) : (
                    <Input label={t("kind")} value={t(`kind${draft.kind}`)} readOnly />
                  )}
                </div>
                <div className="grid items-start gap-4 sm:grid-cols-2">
                  <ChoiceField
                    label={optional(t("forJobTitle"))}
                    items={jobTitles.data ?? []}
                    value={draft.jobTitleId}
                    onChange={(next) => setDraft({ ...draft, jobTitleId: next })}
                    none={t("anyJobTitle")}
                  />
                  <ChoiceField
                    label={optional(t("forDepartment"))}
                    items={departments.data ?? []}
                    value={draft.departmentId}
                    onChange={(next) => setDraft({ ...draft, departmentId: next })}
                    none={t("anyDepartment")}
                  />
                </div>
                <p className="text-sm text-kumo-subtle">{t("matchRule")}</p>
                <fieldset className="flex flex-col gap-3">
                  <legend className="mb-1 font-medium">{t("templateItems")}</legend>
                  <p className="text-sm text-kumo-subtle">{draft.held ? t("templateItemsReplace") : t("templateItemsRule")}</p>
                  {draft.items.map((one, at) => (
                    <div key={one.key} className="grid items-start gap-2 sm:grid-cols-[1fr_9rem_6rem_auto] [&>*]:min-w-0">
                      <Input
                        label={t("itemTitle", { n: at + 1 })}
                        required
                        maxLength={kItemMax}
                        value={one.title}
                        error={tried && one.title.trim() === "" ? common("required") : undefined}
                        onChange={(event) => patchItem(one.key, { title: event.target.value })}
                      />
                      <Select
                        label={t("owner")}
                        hideLabel={false}
                        value={one.owner}
                        onValueChange={(next) => patchItem(one.key, { owner: String(next ?? "HR") as Owner })}
                        items={Object.fromEntries(OWNERS.map((owner) => [owner, t(`owner${owner}`)]))}
                        className="w-full"
                      />
                      <Input
                        label={t("itemDueDays")}
                        type="number"
                        step={1}
                        min={-kDayWindow}
                        max={kDayWindow}
                        required
                        value={one.dueDays}
                        error={tried && !dueOk(one.dueDays) ? t("dueDaysInvalid") : undefined}
                        onChange={(event) => patchItem(one.key, { dueDays: event.target.value })}
                        className="tabular-nums"
                      />
                      <Button
                        variant="ghost"
                        shape="square"
                        icon={TrashIcon}
                        aria-label={t("itemRemove", { n: at + 1 })}
                        className="sm:mt-6"
                        disabled={draft.items.length === 1}
                        onClick={() => setDraft({ ...draft, items: draft.items.filter((row) => row.key !== one.key) })}
                      />
                    </div>
                  ))}
                  {draft.items.length < kMaxItems ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={PlusIcon}
                      onClick={() => {
                        setDraft({ ...draft, items: [...draft.items, blankItem(nextKey)] });
                        setNextKey(nextKey + 1);
                      }}
                      className="self-start"
                    >
                      {t("itemAdd")}
                    </Button>
                  ) : null}
                </fieldset>
                {draft.held ? (
                  draft.held.active ? (
                    <Button
                      variant="secondary-destructive"
                      size="sm"
                      icon={ProhibitIcon}
                      className="self-start"
                      onClick={() => {
                        setFault(null);
                        setRetiring(draft.held);
                      }}
                    >
                      {t("templateRetire")}
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={ArrowCounterClockwiseIcon}
                      className="self-start"
                      loading={flip.isPending}
                      onClick={() => draft.held && flip.mutate(draft.held)}
                    >
                      {t("templateRestore")}
                    </Button>
                  )
                ) : null}
                {fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null}
              </div>
            ) : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary loading={save.isPending} onClick={() => draft && submit(draft)}>
              {draft?.held ? common("save") : t("templateAdd")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Alert open={retiring !== null} onOpenChange={(next) => !next && setRetiring(null)} dismissDisabled={flip.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{retiring ? t("templateRetireTitle", { name: retiring.name }) : t("templateRetire")}</LayerDialog.Title>
          <LayerDialog.Description>{t("templateRetireLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            {fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary variant="destructive" loading={flip.isPending} onClick={() => retiring && flip.mutate(retiring)}>
              {t("templateRetire")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </>
  );
}
