"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Failed } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";

interface Department {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
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

/** The api returns the tree flat with parentId, so the shape is built once
 *  here rather than guessed on the server (KEHOACH 4.7).
 */
function branchesOf(rows: Department[], parentId: string | null): Department[] {
  return rows.filter((row) => row.parentId === parentId);
}

function Branch({
  rows,
  parentId,
  depth,
  onPick,
}: {
  rows: Department[];
  parentId: string | null;
  depth: number;
  onPick: ((one: Department) => void) | null;
}) {
  return (
    <>
      {branchesOf(rows, parentId).map((node) => (
        <li key={node.id}>
          <div
            className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-(--color-ground)"
            style={{ paddingInlineStart: `${depth * 20 + 8}px` }}
          >
            <span className="font-mono text-xs text-(--color-muted)">{node.code}</span>
            {onPick ? (
              <button
                type="button"
                onClick={() => onPick(node)}
                className="text-start text-(--color-accent) hover:underline"
              >
                {node.name}
              </button>
            ) : (
              <span>{node.name}</span>
            )}
          </div>
          <ul>
            <Branch rows={rows} parentId={node.id} depth={depth + 1} onPick={onPick} />
          </ul>
        </li>
      ))}
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
  const [name, setName] = useState("");
  const [fault, setFault] = useState<string | null>(null);
  const [fromDepartmentId, setFrom] = useState("");
  const [toDepartmentId, setTo] = useState("");
  const [toManagerCode, setManager] = useState("");

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Department[]>("/departments")).data,
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
    <section className="mx-auto w-full max-w-(--width-read)">
      <h1 className="text-lg font-semibold">{t("orgChart")}</h1>

      {mayWrite ? (
        <Button
          type="button"
          className="mt-4"
          onClick={() => {
            setFault(null);
            reorg.reset();
            setMoving(true);
          }}
        >
          {o("reorgAction")}
        </Button>
      ) : null}

      {departments.isPending ? (
        <p className="mt-6 text-sm text-(--color-muted)">{common("loading")}</p>
      ) : rows.length === 0 ? (
        <p className="mt-6 text-sm text-(--color-muted)">{common("noData")}</p>
      ) : (
        <ul className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface) p-2">
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
          />
        </ul>
      )}

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
