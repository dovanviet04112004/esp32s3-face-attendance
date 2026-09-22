"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Failed } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { useFault } from "@/lib/fault";

interface Department {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  costCentre: string | null;
  legalEntityId: string;
}

interface Entity {
  id: string;
  name: string;
}

const kIndentPx = 18;

function childrenOf(rows: Department[], parentId: string | null): Department[] {
  return rows.filter((row) => row.parentId === parentId);
}

interface LevelProps {
  rows: Department[];
  parentId: string | null;
  depth: number;
  open: ReadonlySet<string>;
  onFlip: (id: string) => void;
}

function Level({ rows, parentId, depth, open, onFlip }: LevelProps) {
  const t = useTranslations("org");
  const common = useTranslations("common");
  return (
    <>
      {childrenOf(rows, parentId).map((node) => {
        const kids = childrenOf(rows, node.id);
        // The company opens itself, so a first look is the blocks and nothing
        // under them: forty-five rows say less about shape than nine do.
        const shown = depth === 0 || open.has(node.id);
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
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              {kids.length > 0 && !shown ? (
                <span className="shrink-0 text-xs text-(--color-muted) tabular-nums">
                  {t("units", { count: kids.length })}
                </span>
              ) : null}
              <span className="w-24 shrink-0 text-end text-xs text-(--color-muted)">
                {node.costCentre ?? common("empty")}
              </span>
            </div>
            {shown && kids.length > 0 ? (
              <ul>
                <Level rows={rows} parentId={node.id} depth={depth + 1} open={open} onFlip={onFlip} />
              </ul>
            ) : null}
          </li>
        );
      })}
    </>
  );
}

export default function DepartmentsPage() {
  const t = useTranslations("org");
  const common = useTranslations("common");
  const role = useSession((s) => s.role);
  const mayWrite = role === "ADMIN" || role === "HR";
  const cache = useQueryClient();
  const faultOf = useFault();

  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [fault, setFault] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  function flip(id: string): void {
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  }

  const entities = useQuery({
    queryKey: ["legal-entities"],
    queryFn: async () => (await api.get<Entity[]>("/legal-entities")).data,
  });

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Department[]>("/departments")).data,
  });

  const addDepartment = useMutation({
    mutationFn: () =>
      api.post("/departments", {
        legalEntityId: entities.data?.[0]?.id,
        name,
        parentId: parentId || undefined,
      }),
    onSuccess: () => {
      setName("");
      setParentId("");
      void cache.invalidateQueries({ queryKey: ["departments"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const rows = departments.data ?? [];

  if (departments.isError) {
    return <Failed onRetry={() => void departments.refetch()} />;
  }

  return (
    <section>
      <h1 className="mt-2 text-lg font-semibold">{t("departments")}</h1>
      <p className="mt-1 mb-4 text-sm text-(--color-muted)">{t("departmentsLead")}</p>

      {mayWrite ? (
        <form
          className="mb-4 flex flex-wrap items-end gap-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            setFault(null);
            addDepartment.mutate();
          }}
        >
          <label className="block min-w-48 flex-1 text-xs text-(--color-muted)">
            {t("name")}
            <Input
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1"
            />
          </label>
          <label className="block w-56 text-xs text-(--color-muted)">
            {t("parent")}
            <Select
              value={parentId}
              onChange={(event) => setParentId(event.target.value)}
              className="mt-1"
            >
              <option value="">{t("noParent")}</option>
              {(departments.data ?? []).map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                </option>
              ))}
            </Select>
          </label>
          <Button type="submit" disabled={addDepartment.isPending}>
            {addDepartment.isPending ? common("saving") : t("newDepartment")}
          </Button>
        </form>
      ) : null}

      {fault ? (
        <p role="alert" className="mb-3 text-sm text-(--color-danger)">
          {fault}
        </p>
      ) : null}

      {departments.isPending ? (
        <p className="px-4 py-6 text-sm text-(--color-muted)">{common("loading")}</p>
      ) : (
        <div className="rounded-xl border border-(--color-line) bg-(--color-surface) p-2">
          <div className="flex items-center gap-2 border-b border-(--color-line) px-2 pb-2 text-xs text-(--color-muted)">
            <span className="size-6 shrink-0 pointer-coarse:size-11" aria-hidden />
            <span className="w-20 shrink-0">{t("code")}</span>
            <span className="min-w-0 flex-1">{t("name")}</span>
            <span className="w-24 shrink-0 text-end">{t("costCentre")}</span>
          </div>
          <ul>
            <Level rows={rows} parentId={null} depth={0} open={open} onFlip={flip} />
          </ul>
        </div>
      )}
    </section>
  );
}
