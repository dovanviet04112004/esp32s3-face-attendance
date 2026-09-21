"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { dayOnly } from "@/lib/format";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useFault } from "@/lib/fault";

const KINDS = ["ONBOARDING", "OFFBOARDING"] as const;

type Kind = (typeof KINDS)[number];

interface Task {
  id: string;
  title: string;
  ownerRole: "MANAGER" | "SELF" | "HR";
  ownerId: number | null;
  dueOn: string;
  doneAt: string | null;
  note: string | null;
}

interface Run {
  id: string;
  kind: Kind;
  anchorDate: string;
  tasks: Task[];
  template: { name: string };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function Checklist({ employeeId, mayWrite }: { employeeId: number; mayWrite: boolean }) {
  const t = useTranslations("onboarding");
  const format = useFormatter();
  const common = useTranslations("common");
  const cache = useQueryClient();
  const faultOf = useFault();

  const [kind, setKind] = useState<Kind>("ONBOARDING");
  const [anchorDate, setAnchorDate] = useState(today);
  const [fault, setFault] = useState<string | null>(null);

  const run = useQuery({
    queryKey: ["checklist", employeeId, kind],
    retry: false,
    queryFn: async () =>
      (await api.get<Run>(`/employees/${employeeId}/checklist?kind=${kind}`)).data,
  });

  const start = useMutation({
    mutationFn: () => api.post("/checklists", { employeeId, kind, anchorDate }),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["checklist", employeeId] }),
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const finish = useMutation({
    mutationFn: (taskId: string) => api.post(`/checklist-tasks/${taskId}/finish`, {}),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["checklist", employeeId] });
      void cache.invalidateQueries({ queryKey: ["checklists", "open"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const none = isAxiosError(run.error) && run.error.response?.status === 404;
  const tasks = run.data?.tasks ?? [];
  const left = tasks.filter((one) => one.doneAt === null).length;

  return (
    <div className="mt-4">
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="w-48">
          <label className="block text-xs text-(--color-muted)" htmlFor="checklistKind">
            {t("kind")}
          </label>
          <Select
            id="checklistKind"
            value={kind}
            onChange={(event) => setKind(event.target.value as Kind)}
            className="mt-1"
          >
            {KINDS.map((one) => (
              <option key={one} value={one}>
                {t(`kind${one}`)}
              </option>
            ))}
          </Select>
        </div>
        {mayWrite && none ? (
          <>
            <div className="w-44">
              <label className="block text-xs text-(--color-muted)" htmlFor="anchorDate">
                {t("anchor")}
              </label>
              <Input
                id="anchorDate"
                type="date"
                value={anchorDate}
                onChange={(event) => setAnchorDate(event.target.value)}
                className="mt-1"
              />
            </div>
            <Button
              type="button"
              disabled={start.isPending}
              onClick={() => {
                setFault(null);
                start.mutate();
              }}
            >
              {start.isPending ? common("saving") : t("start")}
            </Button>
          </>
        ) : null}
      </div>

      {fault ? (
        <p role="alert" className="mb-3 text-sm text-(--color-danger)">
          {fault}
        </p>
      ) : null}

      {run.isPending ? (
        <p className="text-sm text-(--color-muted)">{common("loading")}</p>
      ) : none || !run.data ? (
        <p className="text-sm text-(--color-muted)">{t("noRun")}</p>
      ) : (
        <>
          <p className="mb-2 text-sm text-(--color-muted)">
            {run.data.template.name} · {t("leftCount", { count: left })}
          </p>
          <ul className="divide-y divide-(--color-line) rounded-xl border border-(--color-line) bg-(--color-surface)">
            {tasks.map((one) => (
              <li key={one.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                <span className={cn("min-w-0 flex-1", one.doneAt && "text-(--color-muted) line-through")}>
                  {one.title}
                </span>
                <span className="text-xs text-(--color-muted)">{t(`owner${one.ownerRole}`)}</span>
                <span
                  className={cn(
                    "tabular-nums text-xs",
                    !one.doneAt && one.dueOn.slice(0, 10) < today()
                      ? "text-(--color-warn)"
                      : "text-(--color-muted)",
                  )}
                >
                  {format.dateTime(dayOnly(one.dueOn), "day")}
                </span>
                {one.doneAt ? (
                  <span className="text-xs text-(--color-ok)">{t("done")}</span>
                ) : (
                  <Button
                    type="button"
                    tone="quiet"
                    size="sm"
                    disabled={finish.isPending}
                    onClick={() => {
                      setFault(null);
                      finish.mutate(one.id);
                    }}
                  >
                    {t("finish")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
