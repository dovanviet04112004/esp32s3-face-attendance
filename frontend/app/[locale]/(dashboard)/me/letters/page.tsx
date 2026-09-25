"use client";

import { Banner, Button, Input, LayerDialog, Loader, Select } from "@cloudflare/kumo";
import { EyeIcon, FilePlusIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { Suspense, useState, type FormEvent } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { Failed } from "@/components/ui/failed";
import { useNotify } from "@/components/ui/notify";
import { PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill, type Tone } from "@/components/ui/pill";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";

const KINDS = ["EMPLOYMENT", "INCOME"] as const;
type Kind = (typeof KINDS)[number];
const MONTH_CHOICES = [1, 3, 6, 12];
const DEFAULT_MONTHS = 3;
const kHere = "/me/letters";
const kAskForm = "letter-form";

type LetterState = "REQUESTED" | "ISSUED" | "REJECTED";

const LETTER_TONE: Record<LetterState, Tone> = {
  REQUESTED: "waiting",
  ISSUED: "good",
  REJECTED: "bad",
};

interface Letter {
  id: string;
  kind: Kind;
  state: LetterState;
  purpose: string;
  months: number | null;
  serial: string | null;
  createdAt: string;
  issuedAt: string | null;
  note: string | null;
}

function MyLetters() {
  const t = useTranslations("certificates");
  const common = useTranslations("common");
  const format = useFormatter();
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();
  const router = useRouter();
  const search = useSearchParams();
  const employeeId = useSession((one) => one.employeeId);

  const [asking, setAsking] = useState(false);
  const [kind, setKind] = useState<Kind>("EMPLOYMENT");
  const [purpose, setPurpose] = useState("");
  const [months, setMonths] = useState(DEFAULT_MONTHS);
  const [refused, setRefused] = useState<string | null>(null);
  const [opened, setOpened] = useState<Letter | null>(null);
  const linked = search.get("new") !== null;

  const letters = useQuery({
    queryKey: ["certificates", "mine", employeeId],
    enabled: employeeId !== null,
    queryFn: async () => (await api.get<{ rows: Letter[] }>(`/certificates?employeeId=${employeeId}`)).data.rows,
  });

  const text = useQuery({
    queryKey: ["certificates", opened?.id, "letter"],
    enabled: opened?.state === "ISSUED",
    queryFn: async () => (await api.get<{ serial: string; text: string }>(`/certificates/${opened?.id}/letter`)).data,
  });

  const ask = useMutation({
    mutationFn: async () => api.post("/certificates", { kind, purpose, ...(kind === "INCOME" ? { months } : {}) }),
    onSuccess: () => {
      notify.done(t("asked"));
      closeAsk();
      void cache.invalidateQueries({ queryKey: ["certificates"] });
    },
    onError: (fell: unknown) => setRefused(faultOf(fell)),
  });

  function openAsk(): void {
    setKind("EMPLOYMENT");
    setPurpose("");
    setMonths(DEFAULT_MONTHS);
    setRefused(null);
    setAsking(true);
  }

  function closeAsk(): void {
    setAsking(false);
    if (linked) {
      router.replace(kHere, { scroll: false });
    }
  }

  const columns: Column<Letter>[] = [
    {
      id: "kind",
      header: t("kind"),
      sortBy: (row) => row.kind,
      cell: (row) => <span className="font-medium">{t(row.kind)}</span>,
    },
    {
      id: "purpose",
      header: t("purpose"),
      cell: (row) => (
        <span className="flex flex-col">
          <span className="line-clamp-2">{row.purpose}</span>
          {row.note ? <span className="text-kumo-danger">{row.note}</span> : null}
        </span>
      ),
    },
    {
      id: "askedOn",
      header: t("askedOn"),
      sortBy: (row) => row.createdAt,
      cell: (row) => <span className="tabular-nums">{format.dateTime(new Date(row.createdAt), "day")}</span>,
    },
    {
      id: "state",
      header: t("state"),
      sortBy: (row) => row.state,
      cell: (row) => <StatePill tone={LETTER_TONE[row.state]}>{t(row.state)}</StatePill>,
    },
    {
      id: "serial",
      header: t("serial"),
      cell: (row) => <span className="font-mono">{row.serial ?? common("empty")}</span>,
    },
  ];

  const dialogOpen = asking || linked;

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("lead")}
        actions={
          <Button variant="primary" icon={FilePlusIcon} onClick={openAsk}>
            {t("ask")}
          </Button>
        }
      />

      <PageLayout>
        <DataTable
          id="my-letters"
          cardLead="kind"
          columns={columns}
          rows={letters.data}
          keyOf={(row) => row.id}
          pending={letters.isPending}
          failed={letters.isError}
          onRetry={() => void letters.refetch()}
          empty={t("empty")}
          emptyHint={t("emptyHint")}
          emptyAction={
            <Button variant="primary" icon={FilePlusIcon} onClick={openAsk}>
              {t("ask")}
            </Button>
          }
          onRowClick={setOpened}
          rowActions={(row) =>
            row.state === "ISSUED" ? [{ key: "view", label: t("view"), icon: EyeIcon, onSelect: () => setOpened(row) }] : []
          }
        />
      </PageLayout>

      <LayerDialog.Root open={dialogOpen} onOpenChange={(next) => (next ? setAsking(true) : closeAsk())} dismissDisabled={ask.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("ask")}</LayerDialog.Title>
          <LayerDialog.Description>{t("askLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <form
              id={kAskForm}
              className="flex flex-col gap-4"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                setRefused(null);
                ask.mutate();
              }}
            >
              <Select
                label={t("kind")}
                hideLabel={false}
                className="w-full"
                value={kind}
                onValueChange={(next) => setKind(String(next ?? "EMPLOYMENT") as Kind)}
                items={Object.fromEntries(KINDS.map((one) => [one, t(one)]))}
              />
              {kind === "INCOME" ? (
                <Select
                  label={t("months")}
                  hideLabel={false}
                  className="w-full"
                  value={String(months)}
                  onValueChange={(next) => setMonths(Number(next ?? DEFAULT_MONTHS))}
                  items={Object.fromEntries(MONTH_CHOICES.map((one) => [String(one), t("monthsN", { count: one })]))}
                />
              ) : null}
              <Input
                label={t("purpose")}
                required
                maxLength={200}
                value={purpose}
                placeholder={t("purposeHint")}
                onChange={(event) => setPurpose(event.target.value)}
              />
              {refused ? <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title={refused} /> : null}
            </form>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary type="submit" form={kAskForm} loading={ask.isPending}>
              {t("ask")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Root open={opened !== null} onOpenChange={(next) => !next && setOpened(null)}>
        <LayerDialog.Content size="lg" closeLabel={common("close")}>
          <LayerDialog.Title>
            {opened ? (opened.serial ? `${t(opened.kind)} · ${opened.serial}` : t(opened.kind)) : t("title")}
          </LayerDialog.Title>
          <LayerDialog.Description>
            {opened ? `${opened.purpose} · ${format.dateTime(new Date(opened.createdAt), "day")}` : ""}
          </LayerDialog.Description>
          <LayerDialog.Body>
            {opened?.state === "REJECTED" ? (
              <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={t("rejectedTitle")} description={opened.note ?? t("noNote")} />
            ) : opened?.state === "REQUESTED" ? (
              <p className="text-kumo-subtle">{t("stillWaiting")}</p>
            ) : text.isError ? (
              <Failed onRetry={() => void text.refetch()} />
            ) : text.data ? (
              <pre data-print className="text-base leading-relaxed whitespace-pre-wrap font-sans">
                {text.data.text}
              </pre>
            ) : (
              <div className="grid place-items-center py-10">
                <Loader />
              </div>
            )}
          </LayerDialog.Body>
          {opened?.state === "ISSUED" ? (
            <LayerDialog.Actions dismissLabel={common("close")}>
              <LayerDialog.Actions.Primary disabled={!text.data} onClick={() => window.print()}>
                {t("print")}
              </LayerDialog.Actions.Primary>
            </LayerDialog.Actions>
          ) : null}
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}

// Asking straight from the employee home rides on the query string, which the prerender does not have.
export default function MyLettersPage() {
  return (
    <Suspense>
      <MyLetters />
    </Suspense>
  );
}
