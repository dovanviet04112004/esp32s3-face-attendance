"use client";

import { Banner, Button, Empty, Input, LayerDialog, Select } from "@cloudflare/kumo";
import { CheckIcon, ListChecksIcon, PlusIcon, TrashIcon, UserIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, PageHeader, PageLayout, StatList } from "@/components/ui/page";
import { CountPill, StatePill } from "@/components/ui/pill";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { dayOnly } from "@/lib/format";

const FINISHERS = ["ADMIN", "HR", "MANAGER"];
const MANAGERS_OF_TEMPLATES = ["ADMIN", "HR"];
const KINDS = ["ONBOARDING", "OFFBOARDING"] as const;
const OWNERS = ["HR", "MANAGER", "SELF"] as const;
const kMaxItems = 100;

type Kind = (typeof KINDS)[number];
type Owner = (typeof OWNERS)[number];
type Pick = "all" | "late" | Owner;

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
  items: { title: string; owner: Owner; dueDays: number }[];
}

interface ItemDraft {
  key: number;
  title: string;
  owner: Owner;
  dueDays: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isLate(task: OpenTask): boolean {
  return task.dueOn.slice(0, 10) < today();
}

export default function OnboardingPage() {
  const t = useTranslations("onboarding");
  const common = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const cache = useQueryClient();
  const role = useSession((s) => s.role);
  const faultOf = useFault();
  const notify = useNotify();
  const mayFinish = role !== null && FINISHERS.includes(role);
  const mayManage = role !== null && MANAGERS_OF_TEMPLATES.includes(role);

  const [pick, setPick] = useState<Pick>("all");
  const [kind, setKind] = useState<Kind | "">("");
  const [typed, setTyped] = useState("");
  const search = useSettled(typed.trim());

  const [viewing, setViewing] = useState<Template | null>(null);
  const [creating, setCreating] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateKind, setTemplateKind] = useState<Kind>("ONBOARDING");
  const [items, setItems] = useState<ItemDraft[]>([]);
  const [nextKey, setNextKey] = useState(0);
  const [fault, setFault] = useState<string | null>(null);

  const tasks = useInfiniteQuery({
    queryKey: ["checklists", "open", { pick, kind, search }],
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      if (pick === "late") {
        params.set("overdue", "true");
      } else if (pick !== "all") {
        params.set("owner", pick);
      }
      if (kind) {
        params.set("kind", kind);
      }
      if (search) {
        params.set("search", search);
      }
      if (pageParam) {
        params.set("cursor", pageParam);
      }
      return (await api.get<TaskPage>(`/checklists/open?${params.toString()}`)).data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const counts = useQuery({
    queryKey: ["checklists", "open", "counts", kind],
    queryFn: async () => (await api.get<OpenCounts>(`/checklists/open/counts${kind ? `?kind=${kind}` : ""}`)).data,
  });

  const templates = useQuery({
    queryKey: ["checklist-templates"],
    enabled: mayManage,
    queryFn: async () => (await api.get<Template[]>("/checklist-templates")).data,
  });

  const finish = useMutation({
    mutationFn: async (task: OpenTask) => {
      await api.post(`/checklist-tasks/${task.id}/finish`, {});
      return task;
    },
    onSuccess: (task) => {
      notify.done(t("finished", { title: task.title }));
      void cache.invalidateQueries({ queryKey: ["checklists", "open"] });
      void cache.invalidateQueries({ queryKey: ["checklist", task.run.employee.id] });
    },
    onError: notify.failed,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post("/checklist-templates", {
        kind: templateKind,
        name: templateName.trim(),
        items: items.map((one) => ({ title: one.title.trim(), owner: one.owner, dueDays: Number(one.dueDays) })),
      }),
    onSuccess: () => {
      setCreating(false);
      notify.done(t("templateAdded", { name: templateName.trim() }));
      void cache.invalidateQueries({ queryKey: ["checklist-templates"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function blankItem(key: number): ItemDraft {
    return { key, title: "", owner: "HR", dueDays: "0" };
  }

  function openCreate(): void {
    setFault(null);
    setTemplateName("");
    setTemplateKind("ONBOARDING");
    setItems([blankItem(0), blankItem(1)]);
    setNextKey(2);
    setCreating(true);
  }

  function patchItem(key: number, patch: Partial<ItemDraft>): void {
    setItems((held) => held.map((one) => (one.key === key ? { ...one, ...patch } : one)));
  }

  const rows = tasks.data?.pages.flatMap((one) => one.rows);
  const first = tasks.data?.pages[0];
  const count = (pickOf: (held: OpenCounts) => number) => (counts.data ? pickOf(counts.data) : common("empty"));
  const itemsReady =
    items.length > 0 && items.every((one) => one.title.trim() !== "" && Number.isInteger(Number(one.dueDays)) && one.dueDays !== "");

  const columns: Column<OpenTask>[] = [
    { id: "title", header: t("task"), sortBy: (row) => row.title, cell: (row) => row.title },
    {
      id: "employee",
      header: t("person"),
      sortBy: (row) => row.run.employee.fullName,
      cell: (row) => (
        <span className="flex flex-col">
          <span>{row.run.employee.fullName}</span>
          <span className="font-mono text-sm text-kumo-subtle">{row.run.employee.code}</span>
        </span>
      ),
    },
    {
      id: "due",
      header: t("due"),
      sortBy: (row) => row.dueOn,
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="tabular-nums">{format.dateTime(dayOnly(row.dueOn), "day")}</span>
          {isLate(row) ? <StatePill tone="bad">{t("overdue")}</StatePill> : null}
        </span>
      ),
    },
    { id: "kind", header: t("kind"), sortBy: (row) => row.run.kind, cell: (row) => t(`kind${row.run.kind}`) },
    { id: "owner", header: t("owner"), sortBy: (row) => row.ownerRole, cell: (row) => t(`owner${row.ownerRole}`) },
  ];

  const filtered = pick !== "all" || kind !== "" || search !== "";

  return (
    <>
      <PageHeader title={t("title")} description={t("lead")} />

      <PageLayout
        aside={
          <>
            <AsideCard title={t("summaryTitle")}>
              <StatList
                stats={[
                  { key: "all", label: t("openCount"), value: count((held) => held.open), active: pick === "all", onPick: () => setPick("all") },
                  {
                    key: "late",
                    label: t("overdue"),
                    value: count((held) => held.overdue),
                    tone: (counts.data?.overdue ?? 0) > 0 ? "warning" : undefined,
                    active: pick === "late",
                    onPick: () => setPick("late"),
                  },
                  ...OWNERS.map((owner) => ({
                    key: owner,
                    label: t("ownedBy", { owner: t(`owner${owner}`) }),
                    value: count((held) => held.owners[owner]),
                    active: pick === owner,
                    onPick: () => setPick(owner),
                  })),
                ]}
              />
            </AsideCard>
            {mayManage ? (
              <AsideCard
                title={t("templatesTitle")}
                action={
                  <Button variant="ghost" size="sm" icon={PlusIcon} onClick={openCreate}>
                    {t("templateAdd")}
                  </Button>
                }
              >
                {templates.isError ? (
                  <Failed onRetry={() => void templates.refetch()} />
                ) : templates.isSuccess && templates.data.length === 0 ? (
                  <p className="text-kumo-subtle">{t("templatesEmpty")}</p>
                ) : (
                  <ul className="-mx-2 -my-1 flex flex-col">
                    {(templates.data ?? []).map((one) => (
                      <li key={one.id}>
                        <button
                          type="button"
                          onClick={() => setViewing(one)}
                          className="flex min-h-9 w-full items-center justify-between gap-3 rounded-md px-2 text-start hover:bg-kumo-tint"
                        >
                          <span className="flex min-w-0 flex-col py-1">
                            <span className="truncate">{one.name}</span>
                            <span className="text-sm text-kumo-subtle">{t(`kind${one.kind}`)}</span>
                          </span>
                          <CountPill>{t("itemCount", { count: one.items.length })}</CountPill>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </AsideCard>
            ) : null}
          </>
        }
      >
        <FilterBar
          search={{ value: typed, onChange: setTyped, placeholder: t("searchHint") }}
          filters={[
            {
              key: "kind",
              label: t("kind"),
              value: kind,
              onChange: (next) => setKind(next as Kind | ""),
              items: { "": t("anyKind"), ONBOARDING: t("kindONBOARDING"), OFFBOARDING: t("kindOFFBOARDING") },
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
          empty={filtered ? t("noMatch") : t("allDone")}
          emptyHint={filtered ? t("noMatchHint") : t("allDoneHint")}
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

      <LayerDialog.Root
        open={viewing !== null}
        onOpenChange={(next) => {
          if (!next) {
            setViewing(null);
          }
        }}
      >
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{viewing?.name ?? t("templatesTitle")}</LayerDialog.Title>
          {viewing ? <LayerDialog.Description>{t(`kind${viewing.kind}`)}</LayerDialog.Description> : null}
          <LayerDialog.Body>
            {viewing && viewing.items.length > 0 ? (
              <ol className="flex flex-col">
                {viewing.items.map((one, at) => (
                  <li key={at} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-kumo-hairline py-2 last:border-0">
                    <span className="min-w-0 flex-1">{one.title}</span>
                    <StatePill>{t(`owner${one.owner}`)}</StatePill>
                    <span className="w-28 shrink-0 text-end text-kumo-subtle tabular-nums">{t("dueDays", { offset: one.dueDays > 0 ? `+${one.dueDays}` : String(one.dueDays) })}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <Empty size="sm" icon={<ListChecksIcon size={32} className="text-kumo-inactive" />} title={t("templateNoItems")} />
            )}
            <p className="mt-4 text-sm text-kumo-subtle">{t("templatesLead")}</p>
          </LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Root open={creating} onOpenChange={setCreating} dismissDisabled={create.isPending}>
        <LayerDialog.Content size="lg" closeLabel={common("close")}>
          <LayerDialog.Title>{t("templateAdd")}</LayerDialog.Title>
          <LayerDialog.Description>{t("templatesLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <form
              id="template-add"
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                setFault(null);
                create.mutate();
              }}
            >
              <div className="grid items-start gap-4 sm:grid-cols-[1fr_12rem]">
                <Input
                  label={t("templateName")}
                  required
                  maxLength={160}
                  value={templateName}
                  onChange={(event) => setTemplateName(event.target.value)}
                />
                <Select
                  label={t("kind")}
                  hideLabel={false}
                  value={templateKind}
                  onValueChange={(next) => setTemplateKind(String(next ?? "ONBOARDING") as Kind)}
                  items={{ ONBOARDING: t("kindONBOARDING"), OFFBOARDING: t("kindOFFBOARDING") }}
                  className="w-full"
                />
              </div>
              <fieldset className="flex flex-col gap-3">
                <legend className="mb-1 font-medium">{t("templateItems")}</legend>
                <p className="text-sm text-kumo-subtle">{t("templateItemsRule")}</p>
                {items.map((one, at) => (
                  <div key={one.key} className="grid items-end gap-2 sm:grid-cols-[1fr_9rem_6rem_auto] [&>*]:min-w-0">
                    <Input
                      label={t("itemTitle", { n: at + 1 })}
                      required
                      maxLength={200}
                      value={one.title}
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
                      required
                      value={one.dueDays}
                      onChange={(event) => patchItem(one.key, { dueDays: event.target.value })}
                      className="tabular-nums"
                    />
                    <Button
                      variant="ghost"
                      shape="square"
                      icon={TrashIcon}
                      aria-label={t("itemRemove", { n: at + 1 })}
                      disabled={items.length === 1}
                      onClick={() => setItems((held) => held.filter((row) => row.key !== one.key))}
                    />
                  </div>
                ))}
                <Button
                  variant="secondary"
                  size="sm"
                  icon={PlusIcon}
                  disabled={items.length >= kMaxItems}
                  onClick={() => {
                    setItems((held) => [...held, blankItem(nextKey)]);
                    setNextKey(nextKey + 1);
                  }}
                  className="self-start"
                >
                  {t("itemAdd")}
                </Button>
              </fieldset>
            </form>
            {fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} className="mt-4" /> : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              type="submit"
              form="template-add"
              loading={create.isPending}
              disabled={templateName.trim() === "" || !itemsReady}
            >
              {t("templateAdd")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}
