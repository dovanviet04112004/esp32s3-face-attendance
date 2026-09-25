"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Failed } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { useFault } from "@/lib/fault";

interface LeaveType {
  id: string;
  code: string;
  name: string;
  paid: boolean;
  daysPerYear: string;
  carryOverMax: string;
  active: boolean;
}

interface Draft {
  code: string;
  name: string;
  paid: boolean;
  daysPerYear: string;
  carryOverMax: string;
}

const kBlank: Draft = { code: "", name: "", paid: true, daysPerYear: "", carryOverMax: "0" };

export default function LeaveTypesPage() {
  const t = useTranslations("leaveTypes");
  const common = useTranslations("common");
  const role = useSession((s) => s.role);
  const mayWrite = role === "ADMIN" || role === "HR";
  const cache = useQueryClient();
  const faultOf = useFault();

  const [editing, setEditing] = useState<LeaveType | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(kBlank);
  const [fault, setFault] = useState<string | null>(null);

  const types = useQuery({
    queryKey: ["leave-types", "all"],
    queryFn: async () => (await api.get<LeaveType[]>("/leave-types/all")).data,
  });

  function done(): void {
    setAdding(false);
    setEditing(null);
    void cache.invalidateQueries({ queryKey: ["leave-types"] });
  }

  const add = useMutation({
    mutationFn: () =>
      api.post("/leave-types", {
        code: draft.code.trim().toUpperCase(),
        name: draft.name.trim(),
        paid: draft.paid,
        daysPerYear: Number(draft.daysPerYear),
        carryOverMax: Number(draft.carryOverMax || "0"),
      }),
    onSuccess: done,
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const save = useMutation({
    mutationFn: (one: LeaveType) =>
      api.patch(`/leave-types/${one.id}`, {
        name: draft.name.trim(),
        paid: draft.paid,
        daysPerYear: Number(draft.daysPerYear),
        carryOverMax: Number(draft.carryOverMax || "0"),
      }),
    onSuccess: done,
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const flip = useMutation({
    mutationFn: (one: LeaveType) => api.patch(`/leave-types/${one.id}`, { active: !one.active }),
    onSuccess: done,
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  if (types.isError) {
    return <Failed onRetry={() => void types.refetch()} />;
  }

  const rows = types.data ?? [];

  return (
    <section className="w-full">
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-(--color-muted)">{t("lead")}</p>

      {mayWrite ? (
        <Button
          type="button"
          className="mt-4"
          onClick={() => {
            setFault(null);
            setDraft(kBlank);
            setAdding(true);
          }}
        >
          {t("add")}
        </Button>
      ) : null}

      {fault ? (
        <p role="alert" className="mt-3 text-sm text-(--color-danger)">
          {fault}
        </p>
      ) : null}

      {types.isPending ? (
        <p className="mt-6 text-sm text-(--color-muted)">{common("loading")}</p>
      ) : rows.length === 0 ? (
        <p className="mt-6 text-sm text-(--color-muted)">{t("empty")}</p>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
          {rows.map((one) => (
            <article
              key={one.id}
              className={cn(
                "rounded-xl border border-(--color-line) bg-(--color-surface) p-4",
                !one.active && "opacity-60",
              )}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-xs text-(--color-muted)">{one.code}</span>
                <span className="min-w-0 flex-1 text-sm font-medium">{one.name}</span>
                <span className="text-xs text-(--color-muted)">
                  {one.paid ? t("paid") : t("unpaid")}
                </span>
                {!one.active ? (
                  <span className="text-xs text-(--color-warn)">{t("retired")}</span>
                ) : null}
              </div>
              <dl className="mt-2 flex flex-wrap gap-x-6 text-sm">
                <div className="flex gap-2">
                  <dt className="text-(--color-muted)">{t("daysPerYear")}</dt>
                  <dd className="tabular-nums">{Number(one.daysPerYear)}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-(--color-muted)">{t("carryOverMax")}</dt>
                  <dd className="tabular-nums">{Number(one.carryOverMax)}</dd>
                </div>
              </dl>
              {mayWrite ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    tone="quiet"
                    size="sm"
                    onClick={() => {
                      setFault(null);
                      setDraft({
                        code: one.code,
                        name: one.name,
                        paid: one.paid,
                        daysPerYear: String(Number(one.daysPerYear)),
                        carryOverMax: String(Number(one.carryOverMax)),
                      });
                      setEditing(one);
                    }}
                  >
                    {t("edit")}
                  </Button>
                  <Button
                    type="button"
                    tone="quiet"
                    size="sm"
                    disabled={flip.isPending}
                    onClick={() => {
                      setFault(null);
                      flip.mutate(one);
                    }}
                  >
                    {one.active ? t("retire") : t("restore")}
                  </Button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}

      <Sheet
        open={adding || editing !== null}
        onClose={() => {
          setAdding(false);
          setEditing(null);
        }}
        title={editing ? `${editing.code} · ${t("edit")}` : t("add")}
        closeLabel={common("close")}
      >
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            setFault(null);
            if (editing) {
              save.mutate(editing);
            } else {
              add.mutate();
            }
          }}
        >
          {editing === null ? (
            <label className="block text-xs text-(--color-muted)">
              {t("code")}
              <Input
                required
                maxLength={32}
                value={draft.code}
                onChange={(event) => setDraft({ ...draft, code: event.target.value.toUpperCase() })}
                className="mt-1 font-mono"
              />
            </label>
          ) : null}
          <label className="mt-3 block text-xs text-(--color-muted)">
            {t("name")}
            <Input
              required
              maxLength={120}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              className="mt-1"
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-3">
            <label className="block w-40 text-xs text-(--color-muted)">
              {t("daysPerYear")}
              <Input
                required
                type="number"
                min={0}
                step={0.5}
                value={draft.daysPerYear}
                onChange={(event) => setDraft({ ...draft, daysPerYear: event.target.value })}
                className="mt-1"
              />
            </label>
            <label className="block w-40 text-xs text-(--color-muted)">
              {t("carryOverMax")}
              <Input
                type="number"
                min={0}
                step={0.5}
                value={draft.carryOverMax}
                onChange={(event) => setDraft({ ...draft, carryOverMax: event.target.value })}
                className="mt-1"
              />
            </label>
          </div>
          <div className="mt-4">
            <Checkbox
              checked={draft.paid}
              onChange={(event) => setDraft({ ...draft, paid: event.target.checked })}
              label={t("paid")}
            />
          </div>
          <p className="mt-4 text-xs text-(--color-muted)">{t("retireLead")}</p>
          <Button type="submit" className="mt-4" disabled={add.isPending || save.isPending}>
            {add.isPending || save.isPending ? common("saving") : t("save")}
          </Button>
        </form>
      </Sheet>
    </section>
  );
}
