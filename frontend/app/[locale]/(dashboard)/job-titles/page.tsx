"use client";

import { Banner, Button, Checkbox, Input, LayerDialog, Select } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, PencilSimpleIcon, PlusIcon, ProhibitIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Suspense, useEffect, useState } from "react";

import { DataTable, PersonCell, type Column, type RowAction } from "@/components/tables/data-table";
import { FilterBar, useSettled } from "@/components/ui/filter-bar";
import { useNotify } from "@/components/ui/notify";
import { useOptional } from "@/components/ui/optional";
import { PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { useUrlState } from "@/lib/url-state";

const CATEGORIES = ["MANAGER", "HIGH_SKILLED", "MID_SKILLED", "OTHER"] as const;
const kCodeMax = 32;
const kNameMax = 128;
const kGradeMax = 99;

type Category = (typeof CATEGORIES)[number];

interface JobTitle {
  id: string;
  code: string;
  name: string;
  grade: number | null;
  laborCategory: Category | null;
  active: boolean;
  holders?: number;
}

interface Draft {
  held: JobTitle | null;
  code: string;
  name: string;
  grade: string;
  category: Category | "";
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

function JobTitles() {
  const t = useTranslations("jobTitles");
  const shared = useTranslations("catalogues");
  const common = useTranslations("common");
  const role = useSession((s) => s.role);
  const mayWrite = role === "ADMIN" || role === "HR";
  const cache = useQueryClient();
  const notify = useNotify();
  const faultOf = useFault();
  const optional = useOptional();

  const [url, setUrl] = useUrlState({ q: "", retired: "" });
  const [typed, setTyped] = useState(url.q);
  const settled = useSettled(typed.trim());
  useEffect(() => {
    if (settled !== url.q) {
      setUrl({ q: settled });
    }
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps

  const [draft, setDraft] = useState<Draft | null>(null);
  const [tried, setTried] = useState(false);
  const [retiring, setRetiring] = useState<JobTitle | null>(null);
  const [fault, setFault] = useState<string | null>(null);

  const titles = useQuery({
    queryKey: ["job-titles", "all"],
    queryFn: async () => (await api.get<JobTitle[]>("/job-titles?all=true")).data,
  });

  function refresh(): void {
    void cache.invalidateQueries({ queryKey: ["job-titles"] });
    void cache.invalidateQueries({ queryKey: ["employees"] });
  }

  const save = useMutation({
    mutationFn: async (held: Draft) => {
      const body = {
        name: held.name.trim(),
        grade: held.grade === "" ? null : Number(held.grade),
        laborCategory: held.category === "" ? null : held.category,
      };
      if (held.held) {
        return (await api.patch<JobTitle>(`/job-titles/${held.held.id}`, body)).data;
      }
      return (await api.post<JobTitle>("/job-titles", { ...body, code: held.code.trim() })).data;
    },
    onSuccess: (saved, held) => {
      notify.done(t(held.held ? "saved" : "added", { name: saved.name }));
      setDraft(null);
      refresh();
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const flip = useMutation({
    mutationFn: async (one: JobTitle) => (await api.patch<JobTitle>(`/job-titles/${one.id}`, { active: !one.active })).data,
    onSuccess: (saved) => {
      notify.done(t(saved.active ? "restoredDone" : "retiredDone", { name: saved.name }));
      setRetiring(null);
      refresh();
    },
    onError: (fell: unknown, one) => (one.active ? setFault(faultOf(fell)) : notify.failed(fell)),
  });

  function open(one: JobTitle | null): void {
    setFault(null);
    setTried(false);
    setDraft({
      held: one,
      code: one?.code ?? "",
      name: one?.name ?? "",
      grade: one?.grade === null || one?.grade === undefined ? "" : String(one.grade),
      category: one?.laborCategory ?? "",
    });
  }

  function submit(held: Draft): void {
    setTried(true);
    if (held.name.trim() === "" || (held.held === null && held.code.trim() === "")) {
      return;
    }
    setFault(null);
    save.mutate(held);
  }

  const needle = fold(url.q);
  const shown = titles.data?.filter(
    (one) =>
      (url.retired === "1" || one.active) && (needle === "" || fold(`${one.code} ${one.name}`).includes(needle)),
  );
  const categoryName = (one: Category | null) => (one ? t(`category_${one}`) : common("empty"));

  const columns: Column<JobTitle>[] = [
    { id: "title", header: shared("name"), cell: (row) => <PersonCell name={row.name} code={row.code} /> },
    {
      id: "grade",
      header: t("grade"),
      numeric: true,
      priority: 2,
      cell: (row) => (row.grade === null ? common("empty") : row.grade),
    },
    { id: "category", header: t("category"), priority: 3, truncate: true, cell: (row) => categoryName(row.laborCategory) },
    { id: "holders", header: t("holders"), numeric: true, priority: 2, cell: (row) => row.holders ?? 0 },
    {
      id: "status",
      header: shared("status"),
      cell: (row) => (
        <StatePill tone={row.active ? "good" : "idle"}>{row.active ? shared("active") : shared("retired")}</StatePill>
      ),
    },
  ];

  function actionsOf(row: JobTitle): RowAction[] {
    const edit: RowAction = { key: "edit", label: shared("edit"), icon: PencilSimpleIcon, onSelect: () => open(row) };
    return row.active
      ? [
          edit,
          {
            key: "retire",
            label: shared("retire"),
            icon: ProhibitIcon,
            danger: true,
            onSelect: () => {
              setFault(null);
              setRetiring(row);
            },
          },
        ]
      : [edit, { key: "restore", label: shared("restore"), icon: ArrowCounterClockwiseIcon, onSelect: () => flip.mutate(row) }];
  }

  const faultBanner = fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null;
  const nameMissing = tried && draft !== null && draft.name.trim() === "";
  const codeMissing = tried && draft !== null && draft.held === null && draft.code.trim() === "";

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("lead")}
        actions={
          mayWrite ? (
            <Button variant="primary" icon={PlusIcon} onClick={() => open(null)}>
              {t("add")}
            </Button>
          ) : undefined
        }
      />

      <PageLayout>
        <FilterBar
          search={{ value: typed, onChange: setTyped, placeholder: shared("searchHint") }}
          extra={
            <Checkbox
              label={shared("showRetired")}
              checked={url.retired === "1"}
              onCheckedChange={(next) => setUrl({ retired: next === true ? "1" : "" })}
            />
          }
        />
        <DataTable
          id="job-titles"
          columns={columns}
          cardLead="title"
          cardTrailing="status"
          rows={shown}
          keyOf={(row) => row.id}
          pending={titles.isPending}
          failed={titles.isError}
          onRetry={() => void titles.refetch()}
          onRowClick={mayWrite ? open : undefined}
          rowActions={mayWrite ? actionsOf : undefined}
          empty={url.q !== "" ? shared("noMatch") : t("empty")}
          emptyHint={url.q !== "" ? undefined : t("emptyHint")}
          emptyAction={
            mayWrite && url.q === "" ? (
              <Button variant="secondary" icon={PlusIcon} onClick={() => open(null)}>
                {t("add")}
              </Button>
            ) : undefined
          }
          paging={shown ? { shown: shown.length, total: shown.length } : undefined}
        />
      </PageLayout>

      <LayerDialog.Root open={draft !== null} onOpenChange={(next) => !next && setDraft(null)} dismissDisabled={save.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{draft?.held ? t("editTitle", { code: draft.held.code }) : t("add")}</LayerDialog.Title>
          <LayerDialog.Description>{draft?.held ? t("editLead") : t("addLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            {draft ? (
              <div className="flex flex-col gap-4">
                {draft.held === null ? (
                  <Input
                    label={shared("code")}
                    required
                    maxLength={kCodeMax}
                    className="font-mono"
                    value={draft.code}
                    description={shared("codeHint")}
                    error={codeMissing ? common("required") : undefined}
                    onChange={(event) => setDraft({ ...draft, code: event.target.value.toUpperCase().replace(/\s/g, "") })}
                  />
                ) : null}
                <Input
                  label={shared("name")}
                  required
                  maxLength={kNameMax}
                  value={draft.name}
                  error={nameMissing ? common("required") : undefined}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
                <Input
                  label={optional(t("grade"))}
                  type="number"
                  min={0}
                  max={kGradeMax}
                  step={1}
                  value={draft.grade}
                  description={t("gradeHint")}
                  onChange={(event) => setDraft({ ...draft, grade: event.target.value })}
                />
                <Select
                  label={optional(t("category"))}
                  hideLabel={false}
                  className="w-full"
                  value={draft.category}
                  onValueChange={(next) => setDraft({ ...draft, category: (String(next ?? "") as Category | "") })}
                  items={{ "": shared("none"), ...Object.fromEntries(CATEGORIES.map((one) => [one, t(`category_${one}`)])) }}
                  description={t("categoryHint")}
                />
                {faultBanner}
              </div>
            ) : null}
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary loading={save.isPending} onClick={() => draft && submit(draft)}>
              {draft?.held ? common("save") : t("add")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Alert open={retiring !== null} onOpenChange={(next) => !next && setRetiring(null)} dismissDisabled={flip.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{retiring ? t("retireTitle", { name: retiring.name }) : shared("retire")}</LayerDialog.Title>
          <LayerDialog.Description>{t("retireLead", { count: retiring?.holders ?? 0 })}</LayerDialog.Description>
          <LayerDialog.Body>{faultBanner}</LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary variant="destructive" loading={flip.isPending} onClick={() => retiring && flip.mutate(retiring)}>
              {shared("retire")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </>
  );
}

export default function JobTitlesPage() {
  return (
    <Suspense>
      <JobTitles />
    </Suspense>
  );
}
