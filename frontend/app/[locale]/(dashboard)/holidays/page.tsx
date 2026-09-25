"use client";

import { Button, Checkbox, Input, LayerDialog, Select } from "@cloudflare/kumo";
import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { NextHoliday } from "@/components/holidays/next-holiday";
import { DataTable, type Column } from "@/components/tables/data-table";
import { FilterBar } from "@/components/ui/filter-bar";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, PageHeader, PageLayout, StatList } from "@/components/ui/page";
import { StatePill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { dayOnly } from "@/lib/format";

interface Holiday {
  id: string;
  date: string;
  name: string;
  paid: boolean;
}

type Paid = "paid" | "unpaid" | "";

const kYearsBack = 3;
const kYearsOn = 1;

export default function HolidaysPage() {
  const t = useTranslations("holidays");
  const common = useTranslations("common");
  const format = useFormatter();
  const role = useSession((s) => s.role);
  const mayWrite = role === "ADMIN" || role === "HR";
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();
  const thisYear = new Date().getFullYear();

  const [year, setYear] = useState(thisYear);
  const [paidOnly, setPaidOnly] = useState<Paid>("");
  const [adding, setAdding] = useState(false);
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
    mutationFn: () => api.post("/holidays", { date, name: name.trim(), paid }),
    onSuccess: () => {
      notify.done(t("added", { name: name.trim() }));
      setAdding(false);
      setYear(Number(date.slice(0, 4)));
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

  function openAdd(): void {
    setFault(null);
    setName("");
    setDate("");
    setPaid(true);
    setAdding(true);
  }

  const rows = holidays.data ?? [];
  const paidDays = rows.filter((one) => one.paid).length;
  const shown = holidays.data?.filter((one) => (paidOnly === "" ? true : paidOnly === "paid" ? one.paid : !one.paid));
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
            <Button variant="primary" icon={PlusIcon} onClick={openAdd}>
              {t("add")}
            </Button>
          ) : undefined
        }
      />

      <PageLayout
        aside={
          <AsideCard title={t("yearTitle", { year })}>
            <StatList
              stats={[
                {
                  key: "paid",
                  label: t("paid"),
                  value: holidays.data ? paidDays : common("empty"),
                  active: paidOnly === "paid",
                  onPick: () => setPaidOnly("paid"),
                },
                {
                  key: "unpaid",
                  label: t("unpaid"),
                  value: holidays.data ? rows.length - paidDays : common("empty"),
                  active: paidOnly === "unpaid",
                  onPick: () => setPaidOnly("unpaid"),
                },
                {
                  key: "all",
                  label: common("all"),
                  value: holidays.data ? rows.length : common("empty"),
                  active: paidOnly === "",
                  onPick: () => setPaidOnly(""),
                },
              ]}
            />
          </AsideCard>
        }
        extra={<NextHoliday linked={false} />}
      >
        <FilterBar
          extra={
            <Select
              aria-label={t("year")}
              value={String(year)}
              onValueChange={(next) => setYear(Number(next))}
              items={years}
              className="min-w-28"
            />
          }
        />
        <DataTable
          id="holidays"
          cardLead="name"
          columns={columns}
          rows={shown}
          keyOf={(row) => row.id}
          pending={holidays.isPending}
          failed={holidays.isError}
          onRetry={() => void holidays.refetch()}
          rowActions={
            mayWrite
              ? (row) => [{ key: "remove", label: t("remove"), icon: TrashIcon, danger: true, onSelect: () => setDropping(row) }]
              : undefined
          }
          empty={paidOnly === "" ? t("empty") : t("noneOfKind")}
          emptyHint={paidOnly === "" ? t("emptyHint") : undefined}
          emptyAction={
            mayWrite && paidOnly === "" ? (
              <Button variant="secondary" icon={PlusIcon} onClick={openAdd}>
                {t("add")}
              </Button>
            ) : undefined
          }
        />
      </PageLayout>

      <LayerDialog.Root open={adding} onOpenChange={setAdding} dismissDisabled={add.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("add")}</LayerDialog.Title>
          <LayerDialog.Description>{t("addLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              <Input label={t("date")} type="date" required value={date} onChange={(event) => setDate(event.target.value)} />
              <Input label={t("name")} required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
              <Checkbox checked={paid} onCheckedChange={(next) => setPaid(next === true)} label={t("paid")} />
              {fault ? <p role="alert" className="text-kumo-danger">{fault}</p> : null}
            </div>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary
              loading={add.isPending}
              disabled={date === "" || name.trim() === ""}
              onClick={() => {
                setFault(null);
                add.mutate();
              }}
            >
              {t("add")}
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
