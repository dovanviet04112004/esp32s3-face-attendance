"use client";

import { Banner, Button, Checkbox, Combobox, Empty, Input, LayerCard, LayerDialog, LinkButton, Select } from "@cloudflare/kumo";
import {
  ArrowCounterClockwiseIcon,
  ArrowsLeftRightIcon,
  CaretRightIcon,
  PencilSimpleIcon,
  PlusIcon,
  ProhibitIcon,
  TreeStructureIcon,
  UsersIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useTranslations } from "next-intl";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";

import { PagingRow } from "@/components/tables/data-table";
import { Failed } from "@/components/ui/failed";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { useNotify } from "@/components/ui/notify";
import { useOptional } from "@/components/ui/optional";
import { AsideCard, Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { PersonPicker, type Person } from "@/components/ui/person-picker";
import { StatePill } from "@/components/ui/pill";
import { SkeletonLine } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { useFault } from "@/lib/fault";
import { useUrlState } from "@/lib/url-state";

interface Department {
  id: string;
  legalEntityId: string;
  code: string;
  name: string;
  parentId: string | null;
  costCentre: string | null;
  headId: number | null;
  head: Person | null;
  active: boolean;
  headcount: number;
}

interface Draft {
  held: Department | null;
  name: string;
  code: string;
  parentId: string;
  costCentre: string;
  head: Person | null;
  entityId: string;
}

interface Choice {
  value: string;
  label: string;
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
const kNameMax = 128;
const kCodeMax = 32;
const kCostCentreMax = 32;
const PHONE = "(max-width: 47.99rem)";

function usePhone(): boolean {
  const listen = useCallback((again: () => void) => {
    const query = window.matchMedia(PHONE);
    query.addEventListener("change", again);
    return () => query.removeEventListener("change", again);
  }, []);
  return useSyncExternalStore(
    listen,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

/** A searchable department field: a flat Select of a big tree hides the one wanted. */
function DepartmentField({
  label,
  description,
  rows,
  value,
  onChange,
  none,
  exclude,
}: {
  label: ReactNode;
  description?: string;
  rows: Department[];
  value: string;
  onChange: (next: string) => void;
  none: string;
  exclude?: ReadonlySet<string>;
}) {
  const common = useTranslations("common");
  const choices = useMemo(
    () => [
      { value: "", label: none },
      ...rows
        .filter((row) => row.active && !exclude?.has(row.id))
        .map((row): Choice => ({ value: row.id, label: `${row.code} · ${row.name}` })),
    ],
    [rows, none, exclude],
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
      description={description}
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

/** The departments a search matches and every one above them, or null when nothing is searched. */
function matching(rows: Department[], needle: string): ReadonlySet<string> | null {
  if (needle === "") {
    return null;
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const keep = new Set<string>();
  for (const row of rows) {
    if (!fold(`${row.code} ${row.name} ${row.head?.fullName ?? ""}`).includes(needle)) {
      continue;
    }
    let at: Department | undefined = row;
    while (at && !keep.has(at.id)) {
      keep.add(at.id);
      at = at.parentId ? byId.get(at.parentId) : undefined;
    }
  }
  return keep;
}

/** A department and everything under it: none of them can become its parent. */
function branchOf(byParent: Map<string | null, Department[]>, id: string): ReadonlySet<string> {
  const out = new Set<string>([id]);
  const walk = (parent: string) => {
    for (const child of byParent.get(parent) ?? []) {
      out.add(child.id);
      walk(child.id);
    }
  };
  walk(id);
  return out;
}

// Roots start open and nothing else does: a first look is the blocks, not forty-five rows.
// A search opens every branch that leads to a match and hides the rest.
function flatten(
  byParent: Map<string | null, Department[]>,
  flipped: ReadonlySet<string>,
  keep: ReadonlySet<string> | null,
): Node[] {
  const out: Node[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const row of byParent.get(parent) ?? []) {
      if (keep && !keep.has(row.id)) {
        continue;
      }
      const kids = (byParent.get(row.id) ?? []).filter((child) => !keep || keep.has(child.id)).length;
      const open = kids > 0 && (keep !== null || (depth === 0) !== flipped.has(row.id));
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
  return (
    <Suspense>
      <Org />
    </Suspense>
  );
}

function Org() {
  const nav = useTranslations("nav");
  const t = useTranslations("org");
  const common = useTranslations("common");
  const cache = useQueryClient();
  const role = useSession((s) => s.role);
  const faultOf = useFault();
  const notify = useNotify();
  const optional = useOptional();
  const mayWrite = role !== null && WRITERS.includes(role);
  const phone = usePhone();

  const [url, setUrl] = useUrlState({ q: "", retired: "", dept: "" });
  const [typed, setTyped] = useState(url.q);
  const settled = useSettled(typed.trim());
  useEffect(() => {
    if (settled !== url.q) {
      setUrl({ q: settled });
    }
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps
  const showRetired = mayWrite && url.retired === "1";

  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const keyed = useRef(false);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const [draft, setDraft] = useState<Draft | null>(null);
  const [tried, setTried] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [retiring, setRetiring] = useState(false);
  const [listing, setListing] = useState(false);
  const [reorging, setReorging] = useState(false);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [boss, setBoss] = useState<Person | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [codeFault, setCodeFault] = useState<string | null>(null);

  const departments = useQuery({
    queryKey: ["departments", "tree", showRetired],
    queryFn: async () => (await api.get<Department[]>(`/departments${showRetired ? "?all=true" : ""}`)).data,
  });

  const entities = useQuery({
    queryKey: ["legal-entities"],
    enabled: mayWrite,
    queryFn: async () => (await api.get<Entity[]>("/legal-entities")).data,
  });

  const rows = useMemo(() => departments.data ?? [], [departments.data]);
  const byParent = useMemo(() => childrenOf(rows), [rows]);
  const keep = useMemo(() => matching(rows, fold(url.q)), [rows, url.q]);
  const visible = flatten(byParent, flipped, keep);
  const chosen = rows.find((row) => row.id === url.dept) ?? byParent.get(null)?.[0] ?? null;
  const chosenWhole = chosen ? wholeOf(byParent, chosen) : 0;
  const parentOfChosen = chosen?.parentId ? rows.find((row) => row.id === chosen.parentId) : undefined;
  const cannotParent = useMemo(() => (chosen ? branchOf(byParent, chosen.id) : new Set<string>()), [byParent, chosen]);
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
    setUrl({ dept: id });
    setFocusId(id);
    if (phone) {
      setSheet(true);
    }
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
    void cache.invalidateQueries({ queryKey: ["employees"] });
  }

  const save = useMutation({
    mutationFn: async (held: Draft) => {
      const body = {
        name: held.name.trim(),
        code: held.code.trim(),
        costCentre: held.costCentre.trim() || null,
        headId: held.head?.id ?? null,
      };
      if (held.held) {
        return (await api.patch<Department>(`/departments/${held.held.id}`, body)).data;
      }
      const parent = rows.find((row) => row.id === held.parentId);
      return (
        await api.post<Department>("/departments", {
          ...body,
          legalEntityId: parent?.legalEntityId ?? (held.entityId || entities.data?.[0]?.id),
          parentId: held.parentId || null,
        })
      ).data;
    },
    onSuccess: (saved, held) => {
      setDraft(null);
      notify.done(t(held.held ? "savedDepartment" : "added", { name: saved.name }));
      if (!held.held) {
        const parent = visible.find((row) => row.id === saved.parentId);
        if (parent && !parent.open) {
          flip(parent.id);
        }
        setUrl({ dept: saved.id });
      }
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

  const move = useMutation({
    mutationFn: async ({ one, parentId }: { one: Department; parentId: string }) =>
      (await api.patch<Department>(`/departments/${one.id}`, { parentId: parentId || null })).data,
    onSuccess: (saved) => {
      setMoving(null);
      notify.done(t("moved", { name: saved.name }));
      refresh();
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const flipActive = useMutation({
    mutationFn: async (one: Department) =>
      (await api.patch<Department>(`/departments/${one.id}`, { active: !one.active })).data,
    onSuccess: (saved) => {
      setRetiring(false);
      notify.done(t(saved.active ? "restoredDone" : "retiredDone", { name: saved.name }));
      refresh();
    },
    onError: (fell: unknown, one) => (one.active ? setFault(faultOf(fell)) : notify.failed(fell)),
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
        setReorging(false);
        notify.done(t("reorgApplied", { count: plan.moving.length }));
        refresh();
      }
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function openForm(one: Department | null): void {
    setSheet(false);
    setFault(null);
    setCodeFault(null);
    setTried(false);
    setDraft({
      held: one,
      name: one?.name ?? "",
      code: one?.code ?? "",
      parentId: one ? (one.parentId ?? "") : (chosen?.id ?? ""),
      costCentre: one?.costCentre ?? "",
      head: one?.head ?? null,
      entityId: entities.data?.[0]?.id ?? "",
    });
  }

  function submit(held: Draft): void {
    setTried(true);
    if (held.name.trim() === "" || held.code.trim() === "") {
      return;
    }
    setFault(null);
    setCodeFault(null);
    save.mutate(held);
  }

  function openMove(): void {
    setSheet(false);
    if (chosen) {
      setFault(null);
      setMoving(chosen.parentId ?? "");
    }
  }

  function openRetire(): void {
    setSheet(false);
    setFault(null);
    setRetiring(true);
  }

  function openReorg(): void {
    setFault(null);
    reorg.reset();
    setFromId(chosen?.id ?? "");
    setToId("");
    setBoss(null);
    setReorging(true);
  }

  function replan(apply: () => void): void {
    reorg.reset();
    setFault(null);
    apply();
  }

  const plan = reorg.data;
  const loaded = members.data?.pages.flatMap((one) => one.rows);
  const firstMembers = members.data?.pages[0];
  const faultBanner = fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} className="mt-4" /> : null;
  const addAction = mayWrite ? (
    <Button variant="primary" icon={PlusIcon} onClick={() => openForm(null)}>
      {t("newDepartment")}
    </Button>
  ) : undefined;

  function panel() {
    if (!chosen) {
      return null;
    }
    return (
      <div className="flex flex-col gap-3">
        {chosen.active ? null : (
          <span>
            <StatePill>{t("retiredPill")}</StatePill>
          </span>
        )}
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
            [
              t("headPerson"),
              chosen.head ? (
                <Link key="head" href={`/employees/${chosen.head.id}`} className="text-end text-kumo-link hover:underline">
                  {chosen.head.fullName}
                </Link>
              ) : (
                t("noHead")
              ),
            ],
            [t("wholeBranch"), t("head", { count: chosenWhole })],
            [t("directly"), t("head", { count: chosen.headcount })],
            [t("costCentre"), chosen.costCentre ?? common("empty")],
          ]}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={UsersIcon}
            onClick={() => {
              setSheet(false);
              setListing(true);
            }}
          >
            {t("seePeople")}
          </Button>
          {mayWrite && chosen.active ? (
            <>
              <Button variant="secondary" size="sm" icon={PencilSimpleIcon} onClick={() => openForm(chosen)}>
                {t("editAction")}
              </Button>
              <Button variant="secondary" size="sm" icon={ArrowsLeftRightIcon} onClick={openMove}>
                {t("moveAction")}
              </Button>
              <Button variant="secondary-destructive" size="sm" icon={ProhibitIcon} onClick={openRetire}>
                {t("retireAction")}
              </Button>
            </>
          ) : null}
          {mayWrite && !chosen.active ? (
            <Button
              variant="secondary"
              size="sm"
              icon={ArrowCounterClockwiseIcon}
              loading={flipActive.isPending}
              onClick={() => flipActive.mutate(chosen)}
            >
              {t("restoreAction")}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  function tree() {
    if (departments.isError) {
      return <Failed onRetry={() => void departments.refetch()} />;
    }
    if (departments.isPending) {
      return (
        <LayerCard className="flex flex-col gap-4 p-4">
          {Array.from({ length: 6 }, (_, at) => (
            <SkeletonLine key={at} minWidth={25} maxWidth={70} />
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
                <Button variant="secondary" icon={PlusIcon} onClick={() => openForm(null)}>
                  {t("newDepartment")}
                </Button>
              ) : undefined
            }
            className="py-12"
          />
        </LayerCard>
      );
    }
    if (visible.length === 0) {
      return (
        <LayerCard className="p-0">
          <Empty size="sm" title={t("searchNone")} className="py-10" />
        </LayerCard>
      );
    }
    return (
      <LayerCard className="p-0 @container">
        <div className="flex items-center gap-2 border-b border-kumo-hairline px-3 py-2 text-sm text-kumo-subtle">
          <span className="min-w-0 flex-1 ps-8">{t("name")}</span>
          <span className="hidden w-44 shrink-0 @min-[640px]:block">{t("headPerson")}</span>
          <span className="hidden w-24 shrink-0 @min-[480px]:block">{t("code")}</span>
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
                <span className={cn("min-w-0 flex-1 truncate", !node.active && "text-kumo-subtle")}>{node.name}</span>
                {node.active ? null : <StatePill>{t("retiredPill")}</StatePill>}
                {node.kids > 0 && !node.open ? (
                  <span className="hidden shrink-0 text-sm text-kumo-subtle tabular-nums @min-[480px]:inline">
                    {t("units", { count: node.kids })}
                  </span>
                ) : null}
                <span className="hidden w-44 shrink-0 truncate text-sm @min-[640px]:block" title={node.head?.fullName}>
                  {node.head?.fullName ?? <span className="text-kumo-subtle">{common("empty")}</span>}
                </span>
                <span className="hidden w-24 shrink-0 truncate font-mono text-sm text-kumo-subtle @min-[480px]:block">{node.code}</span>
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
          !phone && chosen ? (
            <AsideCard title={chosen.name}>{panel()}</AsideCard>
          ) : undefined
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
        <FilterBar
          search={{ value: typed, onChange: setTyped, placeholder: t("searchHint") }}
          extra={
            mayWrite ? (
              <Checkbox
                label={t("showRetired")}
                checked={url.retired === "1"}
                onCheckedChange={(next) => setUrl({ retired: next === true ? "1" : "" })}
              />
            ) : undefined
          }
        />
        {tree()}
      </PageLayout>

      <LayerDialog.Root open={phone && sheet && chosen !== null} onOpenChange={setSheet}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{chosen?.name ?? ""}</LayerDialog.Title>
          <LayerDialog.Body>{panel()}</LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Root open={draft !== null} onOpenChange={(next) => !next && setDraft(null)} dismissDisabled={save.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{draft?.held ? t("editTitle", { name: draft.held.name }) : t("newDepartment")}</LayerDialog.Title>
          <LayerDialog.Description>{draft?.held ? t("editLead") : t("addLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            {draft ? (
              <div className="grid items-start gap-4 sm:grid-cols-2">
                <Input
                  label={t("name")}
                  required
                  maxLength={kNameMax}
                  value={draft.name}
                  error={tried && draft.name.trim() === "" ? common("required") : undefined}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
                <Input
                  label={t("code")}
                  required
                  maxLength={kCodeMax}
                  value={draft.code}
                  error={codeFault ?? (tried && draft.code.trim() === "" ? common("required") : undefined)}
                  onChange={(event) => {
                    setCodeFault(null);
                    setDraft({ ...draft, code: event.target.value.toUpperCase().replace(/\s/g, "") });
                  }}
                  className="font-mono"
                />
                {draft.held === null ? (
                  <div className="sm:col-span-2">
                    <DepartmentField
                      label={optional(t("parent"))}
                      description={t("parentHint")}
                      rows={rows}
                      value={draft.parentId}
                      onChange={(next) => setDraft({ ...draft, parentId: next })}
                      none={t("noParent")}
                    />
                  </div>
                ) : null}
                {draft.held === null && !draft.parentId && (entities.data?.length ?? 0) > 1 ? (
                  <Select
                    label={t("entity")}
                    hideLabel={false}
                    value={draft.entityId}
                    onValueChange={(next) => setDraft({ ...draft, entityId: String(next ?? "") })}
                    items={Object.fromEntries((entities.data ?? []).map((one) => [one.id, one.name]))}
                    className="w-full"
                  />
                ) : null}
                <div className="sm:col-span-2">
                  <PersonPicker
                    label={`${t("headPerson")} ${common("optional")}`}
                    description={t("headHint")}
                    value={draft.head}
                    onChange={(next) => setDraft({ ...draft, head: next })}
                  />
                </div>
                <Input
                  label={optional(t("costCentre"))}
                  maxLength={kCostCentreMax}
                  value={draft.costCentre}
                  onChange={(event) => setDraft({ ...draft, costCentre: event.target.value })}
                />
                <div className="sm:col-span-2">{faultBanner}</div>
              </div>
            ) : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary loading={save.isPending} onClick={() => draft && submit(draft)}>
              {draft?.held ? common("save") : t("newDepartment")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Root open={moving !== null} onOpenChange={(next) => !next && setMoving(null)} dismissDisabled={move.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{chosen ? t("moveTitle", { name: chosen.name }) : t("moveAction")}</LayerDialog.Title>
          <LayerDialog.Description>{t("moveLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <DepartmentField
              label={t("parent")}
              rows={rows.filter((row) => row.legalEntityId === chosen?.legalEntityId)}
              value={moving ?? ""}
              onChange={(next) => setMoving(next)}
              none={t("noParent")}
              exclude={cannotParent}
            />
            {faultBanner}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              loading={move.isPending}
              onClick={() => {
                if (!chosen || moving === null) {
                  return;
                }
                if (moving === (chosen.parentId ?? "")) {
                  setMoving(null);
                  return;
                }
                setFault(null);
                move.mutate({ one: chosen, parentId: moving });
              }}
            >
              {t("moveAction")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Alert open={retiring} onOpenChange={setRetiring} dismissDisabled={flipActive.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{chosen ? t("retireTitle", { name: chosen.name }) : t("retireAction")}</LayerDialog.Title>
          <LayerDialog.Description>{t("retireLead")}</LayerDialog.Description>
          <LayerDialog.Body>{faultBanner}</LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              variant="destructive"
              loading={flipActive.isPending}
              onClick={() => {
                if (chosen) {
                  setFault(null);
                  flipActive.mutate(chosen);
                }
              }}
            >
              {t("retireAction")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>

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
                  <SkeletonLine key={at} minWidth={27} maxWidth={53} />
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

      <LayerDialog.Root open={reorging} onOpenChange={setReorging} dismissDisabled={reorg.isPending}>
        <LayerDialog.Content size="lg" closeLabel={common("close")}>
          <LayerDialog.Title>{t("reorgAction")}</LayerDialog.Title>
          <LayerDialog.Description>{t("reorgLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <div className="grid items-start gap-4 sm:grid-cols-2">
              <DepartmentField
                label={t("reorgFrom")}
                rows={rows}
                value={fromId}
                onChange={(next) => replan(() => setFromId(next))}
                none={common("empty")}
              />
              <DepartmentField
                label={t("reorgTo")}
                rows={rows}
                value={toId}
                onChange={(next) => replan(() => setToId(next))}
                none={t("reorgKeep")}
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
