"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Empty, Failed } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
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
const MANAGERS_OF_TEMPLATES = ["ADMIN", "HR"];
const KINDS = ["ONBOARDING", "OFFBOARDING"] as const;
const OWNERS = ["HR", "MANAGER", "SELF"] as const;

type Kind = (typeof KINDS)[number];

interface Template {
  id: string;
  kind: Kind;
  name: string;
  items: { title: string }[];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** One task a line: title | owner | days from the anchor. A line that does not
 *  read that way is dropped, so a typo cannot become a task nobody owns.
 */
function parseItems(text: string): { title: string; owner: string; dueDays: number }[] {
  return text
    .split("\n")
    .map((line) => line.split("|").map((part) => part.trim()))
    .filter(
      (parts) =>
        parts.length === 3 &&
        parts[0] !== "" &&
        (OWNERS as readonly string[]).includes(parts[1].toUpperCase()) &&
        Number.isInteger(Number(parts[2])),
    )
    .map((parts) => ({
      title: parts[0],
      owner: parts[1].toUpperCase(),
      dueDays: Number(parts[2]),
    }));
}

export default function OnboardingPage() {
  const t = useTranslations("onboarding");
  const common = useTranslations("common");
  const cache = useQueryClient();
  const role = useSession((s) => s.role);
  const faultOf = useFault();
  const mayFinish = role !== null && FINISHERS.includes(role);
  const mayManage = role !== null && MANAGERS_OF_TEMPLATES.includes(role);
  const [fault, setFault] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateKind, setTemplateKind] = useState<Kind>("ONBOARDING");
  const [items, setItems] = useState("");

  const templates = useQuery({
    queryKey: ["checklist-templates"],
    enabled: mayManage && showTemplates,
    queryFn: async () => (await api.get<Template[]>("/checklist-templates")).data,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post("/checklist-templates", {
        kind: templateKind,
        name: templateName,
        items: parseItems(items),
      }),
    onSuccess: () => {
      setTemplateName("");
      setItems("");
      void cache.invalidateQueries({ queryKey: ["checklist-templates"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function addTemplate(event: FormEvent): void {
    event.preventDefault();
    setFault(null);
    create.mutate();
  }

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

      {mayManage ? (
        <div className="mb-4 flex flex-wrap gap-2">
          <Button
            type="button"
            tone="quiet"
            size="sm"
            onClick={() => setShowTemplates(!showTemplates)}
          >
            {showTemplates ? t("hideTemplates") : t("showTemplates")}
          </Button>
        </div>
      ) : null}

      {mayManage && showTemplates ? (
        <section className="mb-6 rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
          <h2 className="text-sm font-medium">{t("templatesTitle")}</h2>
          <p className="mt-1 text-sm text-(--color-muted)">{t("templatesLead")}</p>

          <ul className="mt-3 flex flex-col">
            {(templates.data ?? []).map((one) => (
              <li
                key={one.id}
                className="flex flex-wrap items-center gap-3 border-b border-(--color-line) py-2 text-sm last:border-0"
              >
                <span className="min-w-0 flex-1">{one.name}</span>
                <span className="text-xs text-(--color-muted)">{t(`kind${one.kind}`)}</span>
                <span className="text-xs text-(--color-muted)">
                  {t("itemCount", { count: one.items.length })}
                </span>
              </li>
            ))}
            {templates.isSuccess && (templates.data ?? []).length === 0 ? (
              <li className="py-2 text-sm text-(--color-muted)">{t("templatesEmpty")}</li>
            ) : null}
          </ul>

          <form onSubmit={addTemplate} className="mt-4">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-48 flex-1">
                <label className="block text-xs text-(--color-muted)" htmlFor="templateName">
                  {t("templateName")}
                </label>
                <Input
                  id="templateName"
                  required
                  maxLength={160}
                  value={templateName}
                  onChange={(event) => setTemplateName(event.target.value)}
                  className="mt-1"
                />
              </div>
              <div className="w-40">
                <label className="block text-xs text-(--color-muted)" htmlFor="templateKind">
                  {t("kind")}
                </label>
                <Select
                  id="templateKind"
                  value={templateKind}
                  onChange={(event) => setTemplateKind(event.target.value as Kind)}
                  className="mt-1"
                >
                  {KINDS.map((one) => (
                    <option key={one} value={one}>
                      {t(`kind${one}`)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <label className="mt-3 block text-xs text-(--color-muted)" htmlFor="templateItems">
              {t("templateItems")}
            </label>
            <textarea
              id="templateItems"
              rows={5}
              required
              value={items}
              onChange={(event) => setItems(event.target.value)}
              placeholder={t("templateItemsHint")}
              className="mt-1 w-full rounded-lg border border-(--color-line) bg-(--color-surface) px-3 py-2 font-mono text-xs"
            />
            <p className="mt-1 text-xs text-(--color-muted)">{t("templateItemsRule")}</p>

            <Button type="submit" disabled={create.isPending} className="mt-3">
              {create.isPending ? common("saving") : t("templateAdd")}
            </Button>
          </form>
        </section>
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
