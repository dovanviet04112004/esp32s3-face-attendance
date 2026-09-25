"use client";

import { Banner, Button, Empty, Input, LayerCard, LayerDialog, LinkButton, Select } from "@cloudflare/kumo";
import { CheckCircleIcon, FilesIcon, PlusIcon, TrayArrowDownIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { DataTable, type Column } from "@/components/tables/data-table";
import { DateField } from "@/components/ui/date-field";
import { useNotify } from "@/components/ui/notify";
import { useOptional } from "@/components/ui/optional";
import { StatePill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";
import { dayOnly } from "@/lib/format";

interface FileType {
  id: string;
  code: string;
  name: string;
  required: boolean;
  validMonths: number | null;
}

interface Named {
  typeId: string;
  code: string;
  name: string;
}

interface Gap {
  employeeId: number;
  missing: Named[];
  expired: (Named & { expiresAt: string })[];
}

interface Short extends Named {
  expiresAt: string | null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function Files({ employeeId, mayWrite }: { employeeId: number; mayWrite: boolean }) {
  const t = useTranslations("documents");
  const common = useTranslations("common");
  const format = useFormatter();
  const cache = useQueryClient();
  const faultOf = useFault();
  const notify = useNotify();
  const optional = useOptional();
  const [typeMissing, setTypeMissing] = useState(false);

  const [open, setOpen] = useState(false);
  const [typeId, setTypeId] = useState("");
  const [receivedAt, setReceivedAt] = useState(today);
  const [note, setNote] = useState("");
  const [fault, setFault] = useState<string | null>(null);

  const types = useQuery({
    queryKey: ["personnel-file-types"],
    enabled: mayWrite,
    queryFn: async () => (await api.get<FileType[]>("/personnel-file-types")).data,
  });

  // One person asked for, rather than the whole company read and picked through.
  const gaps = useQuery({
    queryKey: ["personnel-files", "gaps", employeeId],
    queryFn: async () => (await api.get<{ rows: Gap[] }>(`/personnel-files/gaps?employeeId=${employeeId}`)).data.rows,
  });

  const mine = gaps.data?.[0];
  const short: Short[] | undefined = gaps.data
    ? [
        ...(mine?.missing ?? []).map((one) => ({ ...one, expiresAt: null })),
        ...(mine?.expired ?? []).map((one) => ({ ...one, expiresAt: one.expiresAt })),
      ]
    : undefined;

  const receive = useMutation({
    mutationFn: async () => {
      await api.post("/personnel-files", { employeeId, typeId, receivedAt, note: note || undefined });
      return types.data?.find((one) => one.id === typeId)?.name ?? "";
    },
    onSuccess: (name) => {
      setOpen(false);
      notify.done(t("receivedToast", { name }));
      void cache.invalidateQueries({ queryKey: ["personnel-files"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function openReceive(presetType: string): void {
    setFault(null);
    setTypeId(presetType);
    setReceivedAt(today());
    setNote("");
    setOpen(true);
  }

  const columns: Column<Short>[] = [
    {
      id: "type",
      header: t("fileType"),
      sortBy: (row) => row.name,
      cell: (row) => (
        <span className="flex flex-col">
          <span>{row.name}</span>
          <span className="font-mono text-sm text-kumo-subtle">{row.code}</span>
        </span>
      ),
    },
    {
      id: "state",
      header: t("fileState"),
      cell: (row) =>
        row.expiresAt ? (
          <StatePill tone="waiting">{t("expiredOnDay", { day: format.dateTime(dayOnly(row.expiresAt), "day") })}</StatePill>
        ) : (
          <StatePill tone="bad">{t("missing")}</StatePill>
        ),
    },
  ];

  // No type declared means nothing can be missing and nothing can be received, which is not "all in".
  const undeclared = types.isSuccess && types.data.length === 0;
  const declare = (
    <LinkButton href="/documents?tab=types" variant="secondary" icon={PlusIcon}>
      {t("declareTypes")}
    </LinkButton>
  );
  const typeItems = Object.fromEntries(
    (types.data ?? []).map((one) => [one.id, `${one.code} · ${one.name}${one.required ? ` · ${t("requiredMark")}` : ""}`]),
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-lg font-semibold">{t("gapsHere")}</h2>
        {mayWrite && !undeclared ? (
          <Button variant="secondary" icon={PlusIcon} onClick={() => openReceive("")}>
            {t("receiveTitle")}
          </Button>
        ) : null}
      </div>

      {undeclared ? (
        <LayerCard className="p-0">
          <Empty
            icon={<FilesIcon size={40} className="text-kumo-inactive" />}
            title={t("typesEmptyTitle")}
            description={t("typesEmptyHere")}
            contents={declare}
            className="py-12"
          />
        </LayerCard>
      ) : short && short.length === 0 ? (
        <LayerCard className="p-0">
          <Empty
            icon={<CheckCircleIcon size={40} className="text-kumo-success" />}
            title={t("gapsClear")}
            description={t("gapsClearHint")}
            className="py-12"
          />
        </LayerCard>
      ) : (
        <DataTable
          id="employee-files"
          cardLead="type"
          columns={columns}
          rows={short}
          keyOf={(row) => row.typeId}
          pending={gaps.isPending}
          failed={gaps.isError}
          onRetry={() => void gaps.refetch()}
          onRowClick={mayWrite ? (row) => openReceive(row.typeId) : undefined}
          rowActions={
            mayWrite
              ? (row) => [{ key: "receive", label: t("receiveTitle"), icon: TrayArrowDownIcon, onSelect: () => openReceive(row.typeId) }]
              : undefined
          }
        />
      )}

      <LayerDialog.Root open={open} onOpenChange={setOpen} dismissDisabled={receive.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("receiveTitle")}</LayerDialog.Title>
          <LayerDialog.Description>{t("receiveLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            {undeclared ? (
              <Empty
                size="sm"
                icon={<FilesIcon size={32} className="text-kumo-inactive" />}
                title={t("typesEmptyTitle")}
                description={t("typesEmptyHere")}
                contents={declare}
              />
            ) : (
              <form
                id="file-receive"
                className="flex flex-col gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  setFault(null);
                  setTypeMissing(!typeId);
                  if (typeId) {
                    receive.mutate();
                  }
                }}
              >
                <Select
                  label={t("fileType")}
                  placeholder={t("fileTypePick")}
                  loading={types.isPending}
                  value={typeId}
                  onValueChange={(next) => {
                    setTypeId(String(next ?? ""));
                    setTypeMissing(false);
                  }}
                  error={typeMissing ? t("fileTypePick") : undefined}
                  items={typeItems}
                  className="w-full"
                />
                <DateField
                  label={t("receivedAt")}
                  description={t("expiryHint")}
                  required
                  max={today()}
                  value={receivedAt}
                  onChange={setReceivedAt}
                />
                <Input
                  label={optional(t("fileNote"))}
                  maxLength={240}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </form>
            )}
            {fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} className="mt-4" /> : null}
          </LayerDialog.Body>
          {undeclared ? null : (
            <LayerDialog.Actions dismissLabel={common("cancel")}>
              <LayerDialog.Actions.Primary type="submit" form="file-receive" loading={receive.isPending}>
                {t("receiveAction")}
              </LayerDialog.Actions.Primary>
            </LayerDialog.Actions>
          )}
        </LayerDialog.Content>
      </LayerDialog.Root>
    </div>
  );
}
