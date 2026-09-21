"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Empty, Failed } from "@/components/ui/empty";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { useFault } from "@/lib/fault";

interface OpenTask {
  id: string;
  title: string;
  ownerRole: "MANAGER" | "SELF" | "HR";
  dueOn: string;
  run: {
    kind: "ONBOARDING" | "OFFBOARDING";
    employee: { id: number; code: string; fullName: string };
  };
}

const FINISHERS = ["ADMIN", "HR", "MANAGER"];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function OnboardingPage() {
  const t = useTranslations("onboarding");
  const common = useTranslations("common");
  const cache = useQueryClient();
  const role = useSession((s) => s.role);
  const faultOf = useFault();
  const mayFinish = role !== null && FINISHERS.includes(role);
  const [fault, setFault] = useState<string | null>(null);

  const tasks = useQuery({
    queryKey: ["checklists", "open"],
    queryFn: async () => (await api.get<OpenTask[]>("/checklists/open")).data,
  });

  const finish = useMutation({
    mutationFn: (taskId: string) => api.post(`/checklist-tasks/${taskId}/finish`, {}),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["checklists", "open"] });
      void cache.invalidateQueries({ queryKey: ["checklist"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  if (tasks.isError) {
    return <Failed onRetry={() => void tasks.refetch()} />;
  }

  const rows = tasks.data ?? [];
  const late = rows.filter((one) => one.dueOn.slice(0, 10) < today()).length;

  return (
    <section className="mx-auto w-full max-w-(--width-read)">
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="mt-1 mb-4 text-sm text-(--color-muted)">{t("lead")}</p>

      {late > 0 ? (
        <p className="mb-3 text-sm text-(--color-warn)">{t("lateCount", { count: late })}</p>
      ) : null}

      {fault ? (
        <p role="alert" className="mb-3 text-sm text-(--color-danger)">
          {fault}
        </p>
      ) : null}

      {tasks.isPending ? (
        <SkeletonRows rows={4} columns={3} />
      ) : rows.length === 0 ? (
        <Empty title={t("allDone")} hint={t("allDoneHint")} />
      ) : (
        <ul className="divide-y divide-(--color-line) rounded-xl border border-(--color-line) bg-(--color-surface)">
          {rows.map((one) => (
            <li key={one.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p>{one.title}</p>
                <p className="mt-0.5 text-xs text-(--color-muted)">
                  <Link
                    href={`/employees/${one.run.employee.id}?tab=checklist`}
                    className="text-(--color-accent) hover:underline"
                  >
                    {one.run.employee.fullName}
                  </Link>
                  {" · "}
                  {t(`kind${one.run.kind}`)} · {t(`owner${one.ownerRole}`)}
                </p>
              </div>
              <span
                className={cn(
                  "shrink-0 tabular-nums text-xs",
                  one.dueOn.slice(0, 10) < today()
                    ? "text-(--color-warn)"
                    : "text-(--color-muted)",
                )}
              >
                {one.dueOn.slice(0, 10)}
              </span>
              {mayFinish ? (
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
                  {finish.isPending ? common("saving") : t("finish")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
