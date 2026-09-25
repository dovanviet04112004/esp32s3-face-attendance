"use client";

import { Banner, Button, Empty, Input, LayerCard, LayerDialog, Meter, SkeletonLine, Tabs } from "@cloudflare/kumo";
import { CheckIcon, ListChecksIcon, PlayIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { StatePill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";
import { dayOnly } from "@/lib/format";

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

function late(task: Task): boolean {
  return task.doneAt === null && task.dueOn.slice(0, 10) < today();
}

export function Checklist({
  employeeId,
  mayWrite,
  mayFinish = mayWrite,
}: {
  employeeId: number;
  mayWrite: boolean;
  /** Ticking a task off reaches further than starting a list: the manager ticks theirs. */
  mayFinish?: boolean;
}) {
  const t = useTranslations("onboarding");
  const common = useTranslations("common");
  const format = useFormatter();
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();

  const [kind, setKind] = useState<Kind>("ONBOARDING");
  const [starting, setStarting] = useState(false);
  const [anchorDate, setAnchorDate] = useState(today);
  const [fault, setFault] = useState<string | null>(null);

  // No run yet answers empty rather than 404, so an unstarted tab is not a failed read.
  const run = useQuery({
    queryKey: ["checklist", employeeId, kind],
    queryFn: async () => (await api.get<Run | "">(`/employees/${employeeId}/checklist?kind=${kind}`)).data || null,
  });

  const start = useMutation({
    mutationFn: () => api.post("/checklists", { employeeId, kind, anchorDate }),
    onSuccess: () => {
      setStarting(false);
      notify.done(t("started", { kind: t(`kind${kind}`) }));
      void cache.invalidateQueries({ queryKey: ["checklist", employeeId] });
      void cache.invalidateQueries({ queryKey: ["checklists", "open"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const finish = useMutation({
    mutationFn: async (task: Task) => {
      await api.post(`/checklist-tasks/${task.id}/finish`, {});
      return task;
    },
    onSuccess: (task) => {
      notify.done(t("finished", { title: task.title }));
      void cache.invalidateQueries({ queryKey: ["checklist", employeeId] });
      void cache.invalidateQueries({ queryKey: ["checklists", "open"] });
    },
    onError: notify.failed,
  });

  const none = run.isSuccess && run.data === null;
  const tasks = run.data?.tasks ?? [];
  const doneCount = tasks.filter((one) => one.doneAt !== null).length;

  const columns: Column<Task>[] = [
    { id: "title", header: t("task"), cell: (row) => row.title },
    {
      id: "state",
      header: t("state"),
      sortBy: (row) => (row.doneAt ? 2 : late(row) ? 0 : 1),
      cell: (row) =>
        row.doneAt ? (
          <StatePill tone="good">{t("stateDone")}</StatePill>
        ) : late(row) ? (
          <StatePill tone="bad">{t("overdue")}</StatePill>
        ) : (
          <StatePill tone="waiting">{t("stateOpen")}</StatePill>
        ),
    },
    {
      id: "due",
      header: t("due"),
      sortBy: (row) => row.dueOn,
      cell: (row) => <span className="tabular-nums">{format.dateTime(dayOnly(row.dueOn), "day")}</span>,
    },
    { id: "owner", header: t("owner"), sortBy: (row) => row.ownerRole, cell: (row) => t(`owner${row.ownerRole}`) },
  ];

  function body() {
    if (run.isPending) {
      return (
        <LayerCard className="flex flex-col gap-3 p-4">
          {Array.from({ length: 3 }, (_, at) => (
            <SkeletonLine key={at} minWidth={160} maxWidth={420} />
          ))}
        </LayerCard>
      );
    }
    if (none || !run.data) {
      if (run.isError && !none) {
        return <Failed onRetry={() => void run.refetch()} />;
      }
      return (
        <LayerCard className="p-0">
          <Empty
            icon={<ListChecksIcon size={40} className="text-kumo-inactive" />}
            title={t("noRun")}
            description={mayWrite ? t("noRunHint") : undefined}
            contents={
              mayWrite ? (
                <Button
                  variant="secondary"
                  icon={PlayIcon}
                  onClick={() => {
                    setFault(null);
                    setAnchorDate(today());
                    setStarting(true);
                  }}
                >
                  {t("start")}
                </Button>
              ) : undefined
            }
            className="py-12"
          />
        </LayerCard>
      );
    }
    return (
      <>
        <LayerCard className="p-4">
          <Meter
            label={run.data.template.name}
            value={doneCount}
            max={Math.max(tasks.length, 1)}
            customValue={t("doneOf", { done: doneCount, total: tasks.length })}
          />
        </LayerCard>
        <DataTable
          id="employee-checklist"
          cardLead="title"
          columns={columns}
          rows={tasks}
          keyOf={(row) => row.id}
          rowActions={
            mayFinish
              ? (row) =>
                  row.doneAt === null
                    ? [
                        {
                          key: "finish",
                          label: t("finish"),
                          icon: CheckIcon,
                          disabled: finish.isPending,
                          onSelect: () => finish.mutate(row),
                        },
                      ]
                    : []
              : undefined
          }
        />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-lg font-semibold">{t("runTitle")}</h2>
        <Tabs
          variant="segmented"
          tabs={KINDS.map((one) => ({ value: one, label: t(`kind${one}`) }))}
          value={kind}
          onValueChange={(next) => setKind(next as Kind)}
        />
      </div>

      {body()}

      <LayerDialog.Root open={starting} onOpenChange={setStarting} dismissDisabled={start.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("startTitle", { kind: t(`kind${kind}`) })}</LayerDialog.Title>
          <LayerDialog.Description>{t("startLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <form
              id="checklist-start"
              onSubmit={(event) => {
                event.preventDefault();
                setFault(null);
                start.mutate();
              }}
            >
              <Input
                label={t("anchor")}
                description={kind === "ONBOARDING" ? t("anchorHintOn") : t("anchorHintOff")}
                type="date"
                required
                value={anchorDate}
                onChange={(event) => setAnchorDate(event.target.value)}
              />
            </form>
            {fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} className="mt-4" /> : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary type="submit" form="checklist-start" loading={start.isPending}>
              {t("start")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </div>
  );
}
