"use client";

import { Banner, Button, Checkbox, Input, LayerDialog, Select } from "@cloudflare/kumo";
import { PencilSimpleIcon, PlusIcon, TrashIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { Suspense, useState } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { DateField } from "@/components/ui/date-field";
import { FilterBar } from "@/components/ui/filter-bar";
import { useNotify } from "@/components/ui/notify";
import { PageHeader, PageLayout } from "@/components/ui/page";
import { StatePill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { dayOnly } from "@/lib/format";
import { useUrlState } from "@/lib/url-state";

interface Holiday {
  id: string;
  date: string;
  name: string;
  paid: boolean;
}

const kYearsBack = 3;
const kYearsOn = 1;
const kNameMax = 120;

export default function HolidaysPage() {
  return (
    <Suspense>
      <Holidays />
    </Suspense>
  );
}

function Holidays() {
  const t = useTranslations("holidays");
  const common = useTranslations("common");
  const format = useFormatter();
  const role = useSession((s) => s.role);
  const mayWrite = role === "ADMIN" || role === "HR";
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();
  const thisYear = new Date().getFullYear();

  const [url, setUrl] = useUrlState({ year: String(thisYear), pay: "" });
  const year = Number(url.year) || thisYear;
  const [editing, setEditing] = useState<Holiday | null>(null);
  const [adding, setAdding] = useState(false);
  const [tried, setTried] = useState(false);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [paid, setPaid] = useState(true);
  const [fault, setFault] = useState<string | null>(null);
  const [dropping, setDropping] = useState<Holiday | null>(null);

  const holidays = useQuery({
    queryKey: ["holidays", year],
    queryFn: async () => (await api.get<Holiday[]>(`/holidays?year=${year}`)).data,
  });

  const add = useMutation({
    mutationFn: async (): Promise<void> => {
      if (editing) {
        await api.patch(`/holidays/${editing.id}`, { name: name.trim(), paid });
      } else {
        await api.post("/holidays", { date, name: name.trim(), paid });
      }
    },
    onSuccess: () => {
      notify.done(t(editing ? "saved" : "added", { name: name.trim() }));
      if (!editing) {
        setUrl({ year: date.slice(0, 4) });
      }
      setAdding(false);
      setEditing(null);
      void cache.invalidateQueries({ queryKey: ["holidays"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  const drop = useMutation({
    mutationFn: (one: Holiday) => api.delete(`/holidays/${one.id}`),
    onSuccess: (_, one) => {
      notify.done(t("removed", { name: one.name }));
      setDropping(null);
      void cache.invalidateQueries({ queryKey: ["holidays"] });
    },
    onError: notify.failed,
  });

  function openForm(one: Holiday | null): void {
    setFault(null);
    setTried(false);
    setName(one?.name ?? "");
    setDate(one ? one.date.slice(0, 10) : "");
    setPaid(one?.paid ?? true);
    setEditing(one);
    setAdding(one === null);
  }

  function submit(): void {
    setTried(true);
    if (name.trim() === "" || (!editing && date === "")) {
      return;
    }
    setFault(null);
    add.mutate();
  }

  const rows = holidays.data ?? [];
  const paidDays = rows.filter((one) => one.paid).length;
  const shown = holidays.data?.filter((one) => (url.pay === "" ? true : url.pay === "paid" ? one.paid : !one.paid));
  const years = Object.fromEntries(
    Array.from({ length: kYearsBack + kYearsOn + 1 }, (_, at) => String(thisYear - kYearsBack + at)).map((one) => [one, one]),
  );
  const long = (iso: string) => format.dateTime(dayOnly(iso), { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  const columns: Column<Holiday>[] = [
    {
      id: "date",
      header: t("date"),
      sticky: true,
      sortBy: (row) => row.date,
      cell: (row) => (
        <span className="whitespace-nowrap tabular-nums">
          {format.dateTime(dayOnly(row.date), { weekday: "short", day: "numeric", month: "numeric", year: "numeric" })}
        </span>
      ),
    },
    { id: "name", header: t("name"), sortBy: (row) => row.name, cell: (row) => row.name },
    {
      id: "paid",
      header: t("pay"),
      sortBy: (row) => (row.paid ? 1 : 0),
      cell: (row) => <StatePill tone={row.paid ? "good" : "idle"}>{row.paid ? t("paid") : t("unpaid")}</StatePill>,
    },
  ];

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("lead")}
        actions={
          mayWrite ? (
            <Button variant="primary" icon={PlusIcon} onClick={() => openForm(null)}>
              {t("add")}
            </Button>
          ) : undefined
        }
      />

      <PageLayout>
        <FilterBar
          filters={[
            {
              key: "pay",
              label: t("pay"),
              value: url.pay,
              onChange: (next) => setUrl({ pay: next }),
              items: { "": t("anyPay"), paid: t("paid"), unpaid: t("unpaid") },
              counts: holidays.data ? { "": rows.length, paid: paidDays, unpaid: rows.length - paidDays } : undefined,
            },
          ]}
          extra={
            <Select
              aria-label={t("year")}
              value={String(year)}
              onValueChange={(next) => setUrl({ year: String(next ?? thisYear) })}
              items={years}
              className="min-w-28"
            />
          }
        />
        <DataTable
          id="holidays"
          cardLead="name"
          cardTrailing="paid"
          columns={columns}
          rows={shown}
          keyOf={(row) => row.id}
          pending={holidays.isPending}
          failed={holidays.isError}
          onRetry={() => void holidays.refetch()}
          onRowClick={mayWrite ? openForm : undefined}
          rowActions={
            mayWrite
              ? (row) => [
                  { key: "edit", label: t("edit"), icon: PencilSimpleIcon, onSelect: () => openForm(row) },
                  { key: "remove", label: t("remove"), icon: TrashIcon, danger: true, onSelect: () => setDropping(row) },
                ]
              : undefined
          }
          empty={url.pay === "" ? t("empty") : t("noneOfKind")}
          emptyHint={url.pay === "" ? t("emptyHint") : undefined}
          emptyAction={
            mayWrite && url.pay === "" ? (
              <Button variant="secondary" icon={PlusIcon} onClick={() => openForm(null)}>
                {t("add")}
              </Button>
            ) : undefined
          }
        />
      </PageLayout>

      <LayerDialog.Root
        open={adding || editing !== null}
        onOpenChange={(next) => {
          if (!next) {
            setAdding(false);
            setEditing(null);
          }
        }}
        dismissDisabled={add.isPending}
      >
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{editing ? t("editTitle", { name: editing.name }) : t("add")}</LayerDialog.Title>
          <LayerDialog.Description>{editing ? t("editLead", { date: long(editing.date) }) : t("addLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              {editing ? null : (
                <DateField
                  label={t("date")}
                  value={date}
                  error={tried && date === "" ? common("required") : undefined}
                  onChange={setDate}
                />
              )}
              <Input
                label={t("name")}
                required
                maxLength={kNameMax}
                value={name}
                error={tried && name.trim() === "" ? common("required") : undefined}
                onChange={(event) => setName(event.target.value)}
              />
              <Checkbox checked={paid} onCheckedChange={(next) => setPaid(next === true)} label={t("paid")} />
              {fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null}
            </div>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary loading={add.isPending} onClick={submit}>
              {editing ? common("save") : t("add")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Alert open={dropping !== null} onOpenChange={(next) => !next && setDropping(null)} dismissDisabled={drop.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{dropping ? t("removeTitle", { name: dropping.name }) : t("remove")}</LayerDialog.Title>
          <LayerDialog.Description>{dropping ? t("removeLead", { date: long(dropping.date) }) : null}</LayerDialog.Description>
          <LayerDialog.Body>
            <p className="text-kumo-subtle">{t("removeHint")}</p>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary variant="destructive" loading={drop.isPending} onClick={() => dropping && drop.mutate(dropping)}>
              {t("removeConfirm")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Alert>
    </>
  );
}
