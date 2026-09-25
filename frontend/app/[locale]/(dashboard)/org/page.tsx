"use client";

import { Banner, Button, Empty, Input, LayerCard, LayerDialog, LinkButton, Select, SkeletonLine } from "@cloudflare/kumo";
import {
  ArrowsLeftRightIcon,
  CaretRightIcon,
  PencilSimpleIcon,
  PlusIcon,
  TreeStructureIcon,
  UsersIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { PagingRow } from "@/components/tables/data-table";
import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, Facts, PageHeader, PageLayout, StatList } from "@/components/ui/page";
import { PersonPicker, type Person } from "@/components/ui/person-picker";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { useFault } from "@/lib/fault";

interface Department {
  id: string;
  legalEntityId: string;
  code: string;
  name: string;
  parentId: string | null;
  costCentre: string | null;
  headcount: number;
}

interface Entity {
  id: string;
  name: string;
}

interface Node extends Department {
  depth: number;
  kids: number;
  whole: number;
  open: boolean;
}

interface ReorgRow {
  employeeId: number;
  code: string;
  fullName: string;
  fromDepartment: string | null;
  toDepartment: string | null;
}

interface ReorgPlan {
  applied: boolean;
  moving: ReorgRow[];
  losingSight: { managerCode: string; employees: string[] }[];
  requestsReassigned: number;
}

interface Member {
  id: number;
  code: string;
  fullName: string;
}

interface MemberPage {
  rows: Member[];
  total: number;
  totalIsExact?: boolean;
  next: string | null;
}

const WRITERS = ["ADMIN", "HR"];
const kIndentPx = 20;
const kMembersTake = 50;
const kPreviewRows = 50;

/** The api returns the tree flat with parentId; a node whose parent is out of reach counts as a root. */
function childrenOf(rows: Department[]): Map<string | null, Department[]> {
  const known = new Set(rows.map((row) => row.id));
  const byParent = new Map<string | null, Department[]>();
  for (const row of rows) {
    const parent = row.parentId !== null && known.has(row.parentId) ? row.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), row]);
  }
  return byParent;
}

/** People under a node and everything below it, which is what an org chart is read for. */
function wholeOf(byParent: Map<string | null, Department[]>, node: Department): number {
  return (byParent.get(node.id) ?? []).reduce((sum, child) => sum + wholeOf(byParent, child), node.headcount);
}

// Roots start open and nothing else does: a first look is the blocks, not forty-five rows.
function flatten(byParent: Map<string | null, Department[]>, flipped: ReadonlySet<string>): Node[] {
  const out: Node[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const row of byParent.get(parent) ?? []) {
      const kids = (byParent.get(row.id) ?? []).length;
      const open = kids > 0 && (depth === 0) !== flipped.has(row.id);
      out.push({ ...row, depth, kids, whole: wholeOf(byParent, row), open });
      if (open) {
        walk(row.id, depth + 1);
      }
    }
  };
  walk(null, 0);
  return out;
}

export default function OrgPage() {
  const nav = useTranslations("nav");
  const t = useTranslations("org");
  const common = useTranslations("common");
  const cache = useQueryClient();
  const role = useSession((s) => s.role);
  const faultOf = useFault();
  const notify = useNotify();
  const mayWrite = role !== null && WRITERS.includes(role);

  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const keyed = useRef(false);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newParentId, setNewParentId] = useState("");
  const [newCostCentre, setNewCostCentre] = useState("");
  const [newEntityId, setNewEntityId] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [listing, setListing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [boss, setBoss] = useState<Person | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [codeFault, setCodeFault] = useState<string | null>(null);

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Department[]>("/departments")).data,
  });

  const entities = useQuery({
    queryKey: ["legal-entities"],
    enabled: mayWrite,
    queryFn: async () => (await api.get<Entity[]>("/legal-entities")).data,
  });

  const rows = departments.data ?? [];
  const byParent = childrenOf(rows);
  const visible = flatten(byParent, flipped);
  const chosen = rows.find((row) => row.id === chosenId) ?? byParent.get(null)?.[0] ?? null;
  const chosenWhole = chosen ? wholeOf(byParent, chosen) : 0;
  const parentOfChosen = chosen?.parentId ? rows.find((row) => row.id === chosen.parentId) : undefined;
  const shows = (id: string | null | undefined) => id != null && visible.some((row) => row.id === id);
  // A collapsed branch can hide the focused row; the tree must keep one tab stop.
  const focused = shows(focusId) ? focusId : shows(chosen?.id) ? chosen?.id : visible[0]?.id;

  const members = useInfiniteQuery({
    queryKey: ["employees", "of-department", chosen?.id],
    enabled: listing && chosen !== null,
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      const after = pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : "";
      return (
        await api.get<MemberPage>(`/employees?departmentId=${chosen?.id}&active=true&take=${kMembersTake}${after}`)
      ).data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

  useEffect(() => {
    if (keyed.current && focusId) {
      rowRefs.current.get(focusId)?.focus();
      keyed.current = false;
    }
  }, [focusId]);

  function flip(id: string): void {
    setFlipped((held) => {
      const next = new Set(held);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  }

  function choose(id: string): void {
    setChosenId(id);
    setFocusId(id);
  }

  function moveTo(id: string | null | undefined): void {
    if (id && visible.some((row) => row.id === id)) {
      keyed.current = true;
      setFocusId(id);
    }
  }

  function onKey(event: KeyboardEvent, node: Node, at: number): void {
    const handled = new Set(["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End", "Enter", " "]);
    if (!handled.has(event.key)) {
      return;
    }
    event.preventDefault();
    if (event.key === "ArrowDown") {
      moveTo(visible[at + 1]?.id);
    } else if (event.key === "ArrowUp") {
      moveTo(visible[at - 1]?.id);
    } else if (event.key === "Home") {
      moveTo(visible[0]?.id);
    } else if (event.key === "End") {
      moveTo(visible.at(-1)?.id);
    } else if (event.key === "ArrowRight") {
      if (node.kids > 0 && !node.open) {
        flip(node.id);
      } else if (node.open) {
        moveTo(visible[at + 1]?.id);
      }
    } else if (event.key === "ArrowLeft") {
      if (node.open) {
        flip(node.id);
      } else {
        moveTo(node.parentId);
      }
    } else {
      choose(node.id);
    }
  }

  function refresh(): void {
    void cache.invalidateQueries({ queryKey: ["departments"] });
  }

  const add = useMutation({
    mutationFn: async () => {
      const parent = rows.find((row) => row.id === newParentId);
      return (
        await api.post<Department>("/departments", {
          legalEntityId: parent?.legalEntityId ?? (newEntityId || entities.data?.[0]?.id),
          code: newCode.trim(),
          name: newName.trim(),
          parentId: newParentId || undefined,
          costCentre: newCostCentre.trim() || undefined,
        })
      ).data;
    },
    onSuccess: (made) => {
      setAdding(false);
      notify.done(t("added", { name: made.name }));
      const parent = visible.find((row) => row.id === made.parentId);
      if (parent && (parent.depth === 0) === flipped.has(parent.id)) {
        flip(parent.id);
      }
      choose(made.id);
      refresh();
    },
    onError: (fell: unknown) => {
      const code = isAxiosError(fell) ? (fell.response?.data as { message?: unknown } | undefined)?.message : undefined;
      if (code === "DEPARTMENT_CODE_TAKEN") {
        setCodeFault(faultOf(fell));
        return;
      }
      setFault(faultOf(fell));
    },
  });

  const rename = useMutation({
    mutationFn: (one: Department) => api.patch(`/departments/${one.id}`, { name: name.trim() }),
    onSuccess: () => {
      setRenaming(false);
      notify.done(t("renamed"));
      refresh();
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const reorg = useMutation({
    mutationFn: async (apply: boolean) =>
      (
        await api.post<ReorgPlan>(`/org/reorg${apply ? "?apply=true" : ""}`, {
          fromDepartmentId: fromId || undefined,
          toDepartmentId: toId || undefined,
          toManagerCode: boss?.code,
        })
      ).data,
    onSuccess: (plan) => {
      if (plan.applied) {
        setMoving(false);
        notify.done(t("reorgApplied", { count: plan.moving.length }));
        refresh();
        void cache.invalidateQueries({ queryKey: ["employees"] });
      }
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function openAdd(): void {
    setFault(null);
    setCodeFault(null);
    setNewName("");
    setNewCode("");
    setNewCostCentre("");
    setNewParentId(chosen?.id ?? "");
    setNewEntityId(entities.data?.[0]?.id ?? "");
    setAdding(true);
  }

  function openRename(): void {
    if (chosen) {
      setFault(null);
      setName(chosen.name);
      setRenaming(true);
    }
  }

  function openReorg(): void {
    setFault(null);
    reorg.reset();
    setFromId(chosen?.id ?? "");
    setToId("");
    setBoss(null);
    setMoving(true);
  }

  function replan(apply: () => void): void {
    reorg.reset();
    setFault(null);
    apply();
  }

  const departmentItems = (none: string) => ({
    "": none,
    ...Object.fromEntries(rows.map((row) => [row.id, `${row.code} · ${row.name}`])),
  });
  const people = rows.reduce((sum, row) => sum + row.headcount, 0);
  const plan = reorg.data;
  const loaded = members.data?.pages.flatMap((one) => one.rows);
  const firstMembers = members.data?.pages[0];
  const faultBanner = fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} className="mt-4" /> : null;
  const addAction = mayWrite ? (
    <Button variant="primary" icon={PlusIcon} onClick={openAdd}>
      {t("newDepartment")}
    </Button>
  ) : undefined;

  function tree() {
    if (departments.isError) {
      return <Failed onRetry={() => void departments.refetch()} />;
    }
    if (departments.isPending) {
      return (
        <LayerCard className="flex flex-col gap-4 p-4">
          {Array.from({ length: 6 }, (_, at) => (
            <SkeletonLine key={at} minWidth={140} maxWidth={420} />
          ))}
        </LayerCard>
      );
    }
    if (rows.length === 0) {
      return (
        <LayerCard className="p-0">
          <Empty
            icon={<TreeStructureIcon size={40} className="text-kumo-inactive" />}
            title={t("emptyTitle")}
            description={mayWrite ? t("emptyHint") : undefined}
            contents={
              mayWrite ? (
                <Button variant="secondary" icon={PlusIcon} onClick={openAdd}>
                  {t("newDepartment")}
                </Button>
              ) : undefined
            }
            className="py-12"
          />
        </LayerCard>
      );
    }
    return (
      <LayerCard className="p-0">
        <div className="flex items-center gap-2 border-b border-kumo-hairline px-3 py-2 text-sm text-kumo-subtle">
          <span className="min-w-0 flex-1 ps-8">{t("name")}</span>
          <span className="hidden w-24 shrink-0 sm:block">{t("code")}</span>
          <span className="w-28 shrink-0 text-end">{t("headcountColumn")}</span>
        </div>
        <div role="tree" aria-label={nav("orgChart")} className="flex flex-col p-1">
          {visible.map((node, at) => {
            const picked = node.id === chosen?.id;
            return (
              <div
                key={node.id}
                ref={(element) => {
                  if (element) {
                    rowRefs.current.set(node.id, element);
                  } else {
                    rowRefs.current.delete(node.id);
                  }
                }}
                role="treeitem"
                aria-level={node.depth + 1}
                aria-selected={picked}
                aria-expanded={node.kids > 0 ? node.open : undefined}
                tabIndex={node.id === focused ? 0 : -1}
                onClick={() => choose(node.id)}
                onKeyDown={(event) => onKey(event, node, at)}
                onFocus={() => setFocusId(node.id)}
                className={cn(
                  "flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 outline-none select-none pointer-coarse:min-h-11",
                  "hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-line",
                  picked && "bg-kumo-tint font-medium",
                )}
                style={{ paddingInlineStart: `${node.depth * kIndentPx + 4}px` }}
              >
                {node.kids > 0 ? (
                  <span
                    aria-hidden
                    onClick={(event) => {
                      event.stopPropagation();
                      flip(node.id);
                    }}
                    className="grid size-7 shrink-0 place-items-center rounded text-kumo-subtle hover:bg-kumo-base hover:text-kumo-default pointer-coarse:size-11"
                  >
                    <CaretRightIcon size={14} className={cn("transition-transform", node.open && "rotate-90")} />
                  </span>
                ) : (
                  <span className="size-7 shrink-0 pointer-coarse:size-11" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
                {node.kids > 0 && !node.open ? (
                  <span className="hidden shrink-0 text-sm text-kumo-subtle tabular-nums sm:inline">
                    {t("units", { count: node.kids })}
                  </span>
                ) : null}
                <span className="hidden w-24 shrink-0 truncate font-mono text-sm text-kumo-subtle sm:block">{node.code}</span>
                <span className="w-28 shrink-0 text-end tabular-nums">{t("head", { count: node.whole })}</span>
              </div>
            );
          })}
        </div>
      </LayerCard>
    );
  }

  return (
    <>
      <PageHeader title={nav("orgChart")} description={t("treeLead")} actions={addAction} />

      <PageLayout
        aside={
          <>
            <AsideCard title={common("summary")}>
              <StatList
                stats={[
                  { key: "departments", label: t("departmentCount"), value: departments.isSuccess ? rows.length : common("empty") },
                  { key: "people", label: t("peopleCount"), value: departments.isSuccess ? people : common("empty"), href: "/employees" },
                ]}
              />
            </AsideCard>
            {chosen ? (
              <AsideCard title={chosen.name}>
                <div className="flex flex-col gap-3">
                  <Facts
                    rows={[
                      [t("code"), <span key="code" className="font-mono">{chosen.code}</span>],
                      [
                        t("above"),
                        parentOfChosen ? (
                          <button
                            key="parent"
                            type="button"
                            onClick={() => choose(parentOfChosen.id)}
                            className="text-end text-kumo-link hover:underline"
                          >
                            {parentOfChosen.name}
                          </button>
                        ) : (
                          t("noParent")
                        ),
                      ],
                      [t("wholeBranch"), t("head", { count: chosenWhole })],
                      [t("directly"), t("head", { count: chosen.headcount })],
                      [t("costCentre"), chosen.costCentre ?? common("empty")],
                    ]}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" size="sm" icon={UsersIcon} onClick={() => setListing(true)}>
                      {t("seePeople")}
                    </Button>
                    {mayWrite ? (
                      <Button variant="secondary" size="sm" icon={PencilSimpleIcon} onClick={openRename}>
                        {t("renameAction")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </AsideCard>
            ) : null}
          </>
        }
        extra={
          mayWrite ? (
            <AsideCard title={common("tools")}>
              <Button variant="secondary" icon={ArrowsLeftRightIcon} onClick={openReorg} className="w-full justify-start">
                {t("reorgAction")}
              </Button>
            </AsideCard>
          ) : undefined
        }
      >
        {tree()}
      </PageLayout>

      <LayerDialog.Root open={adding} onOpenChange={setAdding} dismissDisabled={add.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("newDepartment")}</LayerDialog.Title>
          <LayerDialog.Body>
            <form
              id="department-add"
              className="grid items-start gap-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                setFault(null);
                setCodeFault(null);
                add.mutate();
              }}
            >
              <Input label={t("name")} required maxLength={128} value={newName} onChange={(event) => setNewName(event.target.value)} />
              <Input
                label={t("code")}
                required
                maxLength={32}
                value={newCode}
                error={codeFault ?? undefined}
                onChange={(event) => {
                  setCodeFault(null);
                  setNewCode(event.target.value.toUpperCase());
                }}
                className="font-mono"
              />
              <Select
                label={t("parent")}
                hideLabel={false}
                value={newParentId}
                onValueChange={(next) => setNewParentId(String(next ?? ""))}
                items={departmentItems(t("noParent"))}
                className="w-full"
              />
              <Input
                label={t("costCentre")}
                maxLength={32}
                value={newCostCentre}
                onChange={(event) => setNewCostCentre(event.target.value)}
              />
              {!newParentId && (entities.data?.length ?? 0) > 1 ? (
                <Select
                  label={t("entity")}
                  hideLabel={false}
                  value={newEntityId}
                  onValueChange={(next) => setNewEntityId(String(next ?? ""))}
                  items={Object.fromEntries((entities.data ?? []).map((one) => [one.id, one.name]))}
                  className="w-full"
                />
              ) : null}
            </form>
            {faultBanner}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              type="submit"
              form="department-add"
              loading={add.isPending}
              disabled={newName.trim() === "" || newCode.trim() === ""}
            >
              {t("newDepartment")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Root open={renaming} onOpenChange={setRenaming} dismissDisabled={rename.isPending}>
        <LayerDialog.Content size="sm" closeLabel={common("close")}>
          <LayerDialog.Title>{t("rename")}</LayerDialog.Title>
          {chosen ? <LayerDialog.Description>{`${chosen.code} · ${chosen.name}`}</LayerDialog.Description> : null}
          <LayerDialog.Body>
            <form
              id="department-rename"
              onSubmit={(event) => {
                event.preventDefault();
                if (chosen) {
                  setFault(null);
                  rename.mutate(chosen);
                }
              }}
            >
              <Input label={t("name")} required maxLength={128} value={name} onChange={(event) => setName(event.target.value)} />
            </form>
            {faultBanner}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              type="submit"
              form="department-rename"
              loading={rename.isPending}
              disabled={name.trim() === "" || name.trim() === chosen?.name}
            >
              {common("save")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Root open={listing} onOpenChange={setListing}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{chosen ? t("peopleOf", { name: chosen.name }) : t("seePeople")}</LayerDialog.Title>
          <LayerDialog.Description>{t("peopleOfLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            {members.isError ? (
              <Failed onRetry={() => void members.refetch()} />
            ) : members.isPending ? (
              <div className="flex flex-col gap-3">
                {Array.from({ length: 4 }, (_, at) => (
                  <SkeletonLine key={at} minWidth={160} maxWidth={320} />
                ))}
              </div>
            ) : loaded && loaded.length > 0 ? (
              <LayerCard className="p-0">
                <ul className="flex flex-col">
                  {loaded.map((one) => (
                    <li key={one.id} className="border-b border-kumo-hairline last:border-0">
                      <Link
                        href={`/employees/${one.id}`}
                        className="flex min-h-10 items-center justify-between gap-3 px-3 py-2 hover:bg-kumo-tint pointer-coarse:min-h-11"
                      >
                        <span className="min-w-0 truncate">{one.fullName}</span>
                        <span className="shrink-0 font-mono text-sm text-kumo-subtle">{one.code}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
                {firstMembers ? (
                  <PagingRow
                    paging={{
                      shown: loaded.length,
                      total: firstMembers.total,
                      exact: firstMembers.totalIsExact,
                      onMore: members.hasNextPage ? () => void members.fetchNextPage() : undefined,
                      loading: members.isFetchingNextPage,
                    }}
                  />
                ) : null}
              </LayerCard>
            ) : (
              <Empty size="sm" icon={<UsersIcon size={32} className="text-kumo-inactive" />} title={t("peopleNone")} description={t("peopleNoneHint")} />
            )}
            {chosen && loaded && loaded.length > 0 ? (
              <LinkButton href={`/employees?departmentId=${chosen.id}`} variant="secondary" icon={UsersIcon} className="mt-4">
                {t("openInDirectory")}
              </LinkButton>
            ) : null}
          </LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Root open={moving} onOpenChange={setMoving} dismissDisabled={reorg.isPending}>
        <LayerDialog.Content size="lg" closeLabel={common("close")}>
          <LayerDialog.Title>{t("reorgAction")}</LayerDialog.Title>
          <LayerDialog.Description>{t("reorgLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <div className="grid items-start gap-4 sm:grid-cols-2">
              <Select
                label={t("reorgFrom")}
                hideLabel={false}
                value={fromId}
                onValueChange={(next) => replan(() => setFromId(String(next ?? "")))}
                items={departmentItems(common("empty"))}
                className="w-full"
              />
              <Select
                label={t("reorgTo")}
                hideLabel={false}
                value={toId}
                onValueChange={(next) => replan(() => setToId(String(next ?? "")))}
                items={departmentItems(t("reorgKeep"))}
                className="w-full"
              />
              <div className="sm:col-span-2">
                <PersonPicker
                  label={t("reorgManager")}
                  description={t("reorgManagerHint")}
                  value={boss}
                  onChange={(next) => replan(() => setBoss(next))}
                />
              </div>
            </div>
            <Button
              variant="secondary"
              className="mt-4"
              loading={reorg.isPending && reorg.variables === false}
              disabled={!fromId || (!toId && !boss)}
              onClick={() => {
                setFault(null);
                reorg.mutate(false);
              }}
            >
              {t("reorgPreview")}
            </Button>
            {faultBanner}
            {plan && !plan.applied ? (
              <div className="mt-4 flex flex-col gap-2">
                <p className="font-medium">
                  {t("reorgWouldMove", { count: plan.moving.length })}
                  {plan.moving.length > kPreviewRows ? (
                    <span className="font-normal text-kumo-subtle"> · {t("reorgShowingFirst", { shown: kPreviewRows })}</span>
                  ) : null}
                </p>
                {plan.requestsReassigned > 0 ? (
                  <p className="text-kumo-subtle">{t("reorgRequests", { count: plan.requestsReassigned })}</p>
                ) : null}
                {plan.losingSight.length > 0 ? (
                  <Banner
                    variant="alert"
                    icon={<WarningCircleIcon weight="fill" />}
                    title={t("reorgLosing", { count: plan.losingSight.length })}
                    description={plan.losingSight.map((one) => one.managerCode).join(", ")}
                  />
                ) : null}
                {plan.moving.length > 0 ? (
                  <ul className="flex max-h-64 flex-col overflow-y-auto">
                    {plan.moving.slice(0, kPreviewRows).map((one) => (
                      <li key={one.employeeId} className="flex flex-wrap gap-x-3 border-b border-kumo-hairline py-1.5 last:border-0">
                        <span className="font-mono">{one.code}</span>
                        <span className="min-w-0 flex-1 truncate">{one.fullName}</span>
                        <span className="text-kumo-subtle">
                          {one.fromDepartment ?? common("empty")} → {one.toDepartment ?? common("empty")}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              loading={reorg.isPending && reorg.variables === true}
              disabled={!plan || plan.applied || plan.moving.length === 0}
              onClick={() => {
                setFault(null);
                reorg.mutate(true);
              }}
            >
              {plan && plan.moving.length > 0 ? t("reorgApplyN", { count: plan.moving.length }) : t("reorgApply")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}
