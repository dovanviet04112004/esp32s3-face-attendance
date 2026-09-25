"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Failed } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";

interface Department {
  id: string;
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

interface ReorgRow {
  employeeId: number;
  code: string;
  fullName: string;
  fromDepartment: string | null;
  toDepartment: string | null;
  fromManager: string | null;
  toManager: string | null;
  pendingRequests: number;
}

interface ReorgPlan {
  applied: boolean;
  moving: ReorgRow[];
  losingSight: { managerCode: string; employees: string[] }[];
  gainingSight: { managerCode: string; employees: string[] }[];
  requestsReassigned: number;
}

const WRITERS = ["ADMIN", "HR"];
const kIndentPx = 18;

/** The api returns the tree flat with parentId, so the shape is built once
 *  here rather than guessed on the server (KEHOACH 4.7).
 */
function branchesOf(rows: Department[], parentId: string | null): Department[] {
  return rows.filter((row) => row.parentId === parentId);
}

/** People under a node and everything below it, which is the number an org
 *  chart is read for; the api counts each node on its own.
 */
function subtreeOf(rows: Department[], node: Department): number {
  return branchesOf(rows, node.id).reduce(
    (sum, child) => sum + subtreeOf(rows, child),
    node.headcount,
  );
}

interface BranchProps {
  rows: Department[];
  parentId: string | null;
  depth: number;
  onPick: ((one: Department) => void) | null;
  open: ReadonlySet<string>;
  onFlip: (id: string) => void;
}

function Branch({ rows, parentId, depth, onPick, open, onFlip }: BranchProps) {
  const t = useTranslations("org");
  const common = useTranslations("common");
  return (
    <>
      {branchesOf(rows, parentId).map((node) => {
        const kids = branchesOf(rows, node.id);
        // The company opens itself and nothing else does: a first look is the
        // blocks, because forty-five rows say less about shape than nine.
        const shown = depth === 0 || open.has(node.id);
        const whole = subtreeOf(rows, node);
        return (
          <li key={node.id}>
            <div
              className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-(--color-ground)"
              style={{ paddingInlineStart: `${depth * kIndentPx + 8}px` }}
            >
              {kids.length > 0 ? (
                <button
                  type="button"
                  aria-expanded={shown}
                  aria-label={t(shown ? "collapse" : "expand")}
                  onClick={() => onFlip(node.id)}
                  className="grid size-6 shrink-0 place-items-center rounded text-(--color-muted) hover:text-(--color-ink) pointer-coarse:size-11"
                >
                  <ChevronRight
                    className={cn("size-4 transition-transform", shown && "rotate-90")}
                    aria-hidden
                  />
                </button>
              ) : (
                <span className="size-6 shrink-0 pointer-coarse:size-11" aria-hidden />
              )}
              <span className="w-20 shrink-0 font-mono text-xs text-(--color-muted)">{node.code}</span>
              {onPick ? (
                <button
                  type="button"
                  onClick={() => onPick(node)}
                  className="min-w-0 flex-1 truncate text-start underline hover:no-underline"
                >
                  {node.name}
                </button>
              ) : (
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
              )}
              {kids.length > 0 && !shown ? (
                <span className="shrink-0 text-xs text-(--color-muted) tabular-nums">
                  {t("units", { count: kids.length })}
                </span>
              ) : null}
              <span className="w-32 shrink-0 text-end text-xs text-(--color-muted) tabular-nums">
                {kids.length > 0 && whole !== node.headcount
                  ? t("headHere", { here: node.headcount, whole })
                  : t("head", { count: node.headcount })}
              </span>
              <span className="hidden w-24 shrink-0 text-end text-xs text-(--color-muted) sm:block">
                {node.costCentre ?? common("empty")}
              </span>
            </div>
            {shown && kids.length > 0 ? (
              <ul>
                <Branch
                  rows={rows}
                  parentId={node.id}
                  depth={depth + 1}
                  onPick={onPick}
                  open={open}
                  onFlip={onFlip}
                />
              </ul>
            ) : null}
          </li>
        );
      })}
    </>
  );
}

export default function OrgPage() {
  const t = useTranslations("nav");
  const o = useTranslations("org");
  const common = useTranslations("common");
  const cache = useQueryClient();
  const role = useSession((s) => s.role);
  const faultOf = useFault();
  const mayWrite = role !== null && WRITERS.includes(role);

  const [renaming, setRenaming] = useState<Department | null>(null);
  const [moving, setMoving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [newName, setNewName] = useState("");
  const [newParentId, setNewParent] = useState("");
  const [fault, setFault] = useState<string | null>(null);
  const [fromDepartmentId, setFrom] = useState("");
  const [toDepartmentId, setTo] = useState("");
  const [toManagerCode, setManager] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  function flip(id: string): void {
    setOpen((held) => {
      const next = new Set(held);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  }

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Department[]>("/departments")).data,
  });

  const entities = useQuery({
    queryKey: ["legal-entities"],
    enabled: mayWrite,
    queryFn: async () => (await api.get<Entity[]>("/legal-entities")).data,
  });

  const add = useMutation({
    mutationFn: () =>
      api.post("/departments", {
        legalEntityId: entities.data?.[0]?.id,
        name: newName,
        parentId: newParentId || undefined,
      }),
    onSuccess: () => {
      setAdding(false);
      setNewName("");
      setNewParent("");
      void cache.invalidateQueries({ queryKey: ["departments"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const rename = useMutation({
    mutationFn: (one: Department) => api.patch(`/departments/${one.id}`, { name }),
    onSuccess: () => {
      setRenaming(null);
      void cache.invalidateQueries({ queryKey: ["departments"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const reorg = useMutation({
    mutationFn: async (apply: boolean) =>
      (
        await api.post<ReorgPlan>(`/org/reorg${apply ? "?apply=true" : ""}`, {
          fromDepartmentId: fromDepartmentId || undefined,
          toDepartmentId: toDepartmentId || undefined,
          toManagerCode: toManagerCode || undefined,
        })
      ).data,
    onSuccess: (plan) => {
      if (plan.applied) {
        void cache.invalidateQueries({ queryKey: ["departments"] });
        void cache.invalidateQueries({ queryKey: ["employees"] });
      }
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  if (departments.isError) {
    return <Failed onRetry={() => void departments.refetch()} />;
  }

  const rows = departments.data ?? [];
  const plan = reorg.data;

  return (
    <section className="w-full">
      <h1 className="text-lg font-semibold">{t("orgChart")}</h1>
      <p className="mt-1 text-sm text-(--color-muted)">{o("treeLead")}</p>

      {mayWrite ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={() => {
              setFault(null);
              setAdding(true);
            }}
          >
            {o("newDepartment")}
          </Button>
          <Button
            type="button"
            tone="quiet"
            onClick={() => {
              setFault(null);
              reorg.reset();
              setMoving(true);
            }}
          >
            {o("reorgAction")}
          </Button>
        </div>
      ) : null}

      {departments.isPending ? (
        <p className="mt-6 text-sm text-(--color-muted)">{common("loading")}</p>
      ) : rows.length === 0 ? (
        <p className="mt-6 text-sm text-(--color-muted)">{common("noData")}</p>
      ) : (
        <div className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface) p-2">
          <div className="flex items-center gap-2 border-b border-(--color-line) px-2 pb-2 text-xs text-(--color-muted)">
            <span className="size-6 shrink-0 pointer-coarse:size-11" aria-hidden />
            <span className="w-20 shrink-0">{o("code")}</span>
            <span className="min-w-0 flex-1">{o("name")}</span>
            <span className="w-32 shrink-0 text-end">{o("headcountColumn")}</span>
            <span className="hidden w-24 shrink-0 text-end sm:block">{o("costCentre")}</span>
          </div>
          <ul>
            <Branch
            rows={rows}
            parentId={null}
            depth={0}
            onPick={
              mayWrite
                ? (one) => {
                    setFault(null);
                    setName(one.name);
                    setRenaming(one);
                  }
                : null
            }
              open={open}
              onFlip={flip}
            />
          </ul>
        </div>
      )}

      <Sheet
        open={adding}
        onClose={() => setAdding(false)}
        title={o("newDepartment")}
        closeLabel={common("close")}
      >
        <label className="block text-xs text-(--color-muted)">
          {o("name")}
          <Input
            required
            maxLength={120}
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            className="mt-1"
          />
        </label>
        <label className="mt-3 block text-xs text-(--color-muted)">
          {o("parent")}
          <Select
            value={newParentId}
            onChange={(event) => setNewParent(event.target.value)}
            className="mt-1"
          >
            <option value="">{o("noParent")}</option>
            {rows.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </Select>
        </label>
        <Button
          type="button"
          className="mt-4"
          disabled={newName === "" || add.isPending}
          onClick={() => {
            setFault(null);
            add.mutate();
          }}
        >
          {add.isPending ? common("saving") : o("newDepartment")}
        </Button>
      </Sheet>

      <Sheet
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title={renaming ? `${renaming.code} · ${o("rename")}` : o("rename")}
        closeLabel={common("close")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setFault(null);
            if (renaming) {
              rename.mutate(renaming);
            }
          }}
        >
          <label className="block text-sm font-medium" htmlFor="deptName">
            {o("name")}
          </label>
          <Input
            id="deptName"
            required
            maxLength={128}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-1"
          />
          {fault ? (
            <p role="alert" className="mt-3 text-sm text-(--color-danger)">
              {fault}
            </p>
          ) : null}
          <Button type="submit" disabled={rename.isPending} className="mt-4">
            {rename.isPending ? common("saving") : common("save")}
          </Button>
        </form>
      </Sheet>

      <Sheet
        open={moving}
        onClose={() => setMoving(false)}
        title={o("reorgAction")}
        closeLabel={common("close")}
        className="sm:max-w-2xl"
      >
        <p className="text-sm text-(--color-muted)">{o("reorgLead")}</p>

        <label className="mt-4 block text-sm font-medium" htmlFor="reorgFrom">
          {o("reorgFrom")}
        </label>
        <Select
          id="reorgFrom"
          value={fromDepartmentId}
          onChange={(event) => setFrom(event.target.value)}
          className="mt-1"
        >
          <option value="">{common("empty")}</option>
          {rows.map((one) => (
            <option key={one.id} value={one.id}>
              {one.code} · {one.name}
            </option>
          ))}
        </Select>

        <label className="mt-4 block text-sm font-medium" htmlFor="reorgTo">
          {o("reorgTo")}
        </label>
        <Select
          id="reorgTo"
          value={toDepartmentId}
          onChange={(event) => setTo(event.target.value)}
          className="mt-1"
        >
          <option value="">{common("empty")}</option>
          {rows.map((one) => (
            <option key={one.id} value={one.id}>
              {one.code} · {one.name}
            </option>
          ))}
        </Select>

        <label className="mt-4 block text-sm font-medium" htmlFor="reorgManager">
          {o("reorgManager")}
        </label>
        <Input
          id="reorgManager"
          maxLength={32}
          value={toManagerCode}
          placeholder={o("reorgManagerHint")}
          onChange={(event) => setManager(event.target.value)}
          className="mt-1"
        />

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            tone="quiet"
            disabled={reorg.isPending}
            onClick={() => {
              setFault(null);
              reorg.mutate(false);
            }}
          >
            {reorg.isPending ? common("loading") : o("reorgPreview")}
          </Button>
          <Button
            type="button"
            tone="danger"
            disabled={reorg.isPending || !plan || plan.applied || plan.moving.length === 0}
            onClick={() => {
              setFault(null);
              reorg.mutate(true);
            }}
          >
            {o("reorgApply")}
          </Button>
        </div>

        {fault ? (
          <p role="alert" className="mt-3 text-sm text-(--color-danger)">
            {fault}
          </p>
        ) : null}

        {plan ? (
          <div className="mt-4 text-sm">
            <p className={plan.applied ? "text-(--color-ok)" : "text-(--color-warn)"}>
              {plan.applied
                ? o("reorgApplied", { count: plan.moving.length })
                : o("reorgWouldMove", { count: plan.moving.length })}
            </p>
            {plan.requestsReassigned > 0 ? (
              <p className="mt-1 text-(--color-muted)">
                {o("reorgRequests", { count: plan.requestsReassigned })}
              </p>
            ) : null}
            {plan.losingSight.length > 0 ? (
              <p className="mt-1 text-(--color-warn)">
                {o("reorgLosing", { count: plan.losingSight.length })}
              </p>
            ) : null}
            <ul className="mt-2 flex max-h-64 flex-col overflow-y-auto">
              {plan.moving.slice(0, 50).map((one) => (
                <li
                  key={one.employeeId}
                  className="flex flex-wrap gap-x-3 border-b border-(--color-line) py-1.5 text-xs last:border-0"
                >
                  <span className="font-mono">{one.code}</span>
                  <span className="min-w-0 flex-1 truncate">{one.fullName}</span>
                  <span className="text-(--color-muted)">
                    {one.fromDepartment ?? common("empty")} → {one.toDepartment ?? common("empty")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Sheet>
    </section>
  );
}
