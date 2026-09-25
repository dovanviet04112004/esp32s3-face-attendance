"use client";

import { Banner, Button, LayerDialog } from "@cloudflare/kumo";
import {
  DesktopIcon,
  DownloadSimpleIcon,
  FileArrowDownIcon,
  FileXlsIcon,
  UploadSimpleIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useTranslations } from "next-intl";
import { useRef, useState, type ChangeEvent } from "react";

import { useNotify } from "@/components/ui/notify";
import { usePhone } from "@/components/ui/page";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_MIME = "text/csv";
// Column names are identifiers the file must carry as they are; only what they mean is translated.
const COLUMNS = {
  required: "code, fullName",
  place: "legalEntityCode, departmentCode, jobTitleCode",
  manager: "managerCode",
  shift: "shiftName, shiftFrom",
  kiosk: "consentPaper, kioskId",
  login: "openLogin",
  values: "dateOfBirth, hireDate, gender, baseSalary, insuranceSalary",
  kept: "personalEmail, bankAccount, bankName",
} as const;
const kListed = 100;

interface ImportFault {
  row: number;
  column: string;
  code: string;
  value: string;
}

interface ChangeLine {
  row: number;
  code: string;
  fields: string[];
  cleared: string[];
}

interface ImportReport {
  applied: boolean;
  rows: number;
  toCreate: number;
  toUpdate: number;
  unchanged: number;
  payKept: number;
  shiftsToAssign: number;
  consentsToRecord: number;
  kiosksToAssign: number;
  loginsToOpen: number;
  changes: ChangeLine[];
  faults: ImportFault[];
  warnings: ImportFault[];
}

interface Upload {
  bytes: ArrayBuffer;
  type: string;
}

function save(blob: Blob, name: string): void {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function fetchFile(path: string): Promise<Blob> {
  try {
    return (await api.get<Blob>(path, { responseType: "blob" })).data;
  } catch (fell) {
    // A refused download still answers a json code, which arrives here as a Blob.
    if (isAxiosError(fell) && fell.response?.data instanceof Blob) {
      fell.response.data = await fell.response.data.text().then(JSON.parse).catch(() => undefined);
    }
    throw fell;
  }
}

function send(upload: Upload, apply: boolean): Promise<ImportReport> {
  return api
    .post<ImportReport>(`/employees/import${apply ? "?apply=true" : ""}`, upload.bytes, {
      headers: { "Content-Type": upload.type },
    })
    .then((res) => res.data);
}

function Lines({ items, text }: { items: ImportFault[]; text: (code: string) => string }) {
  const t = useTranslations("employees");
  return (
    <>
      <ul className="-mx-2 mt-1 flex max-h-60 flex-col overflow-y-auto px-2 text-sm">
        {items.slice(0, kListed).map((one) => (
          <li
            key={`${one.row}-${one.column}-${one.code}`}
            className="grid grid-cols-[4.5rem_minmax(0,9.5rem)_minmax(0,1fr)] gap-x-3 border-b border-kumo-hairline py-2 last:border-0"
          >
            <span className="tabular-nums text-kumo-subtle">{t("importLine", { n: one.row })}</span>
            <span className="truncate font-mono">{one.column}</span>
            <span className="flex min-w-0 flex-col">
              <span>{text(one.code)}</span>
              {one.value ? <span className="truncate font-mono text-kumo-subtle">{one.value}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {items.length > kListed ? <p className="mt-1 text-sm text-kumo-subtle">{t("importMore", { n: items.length - kListed })}</p> : null}
    </>
  );
}

function Changes({ report }: { report: ImportReport }) {
  const t = useTranslations("employees");
  return (
    <div>
      <p className="m-0 font-medium">{t("importChangesTitle", { n: report.toUpdate })}</p>
      <ul className="-mx-2 mt-1 flex max-h-60 flex-col overflow-y-auto px-2 text-sm">
        {report.changes.map((one) => (
          <li
            key={one.row}
            className="grid grid-cols-[4.5rem_minmax(0,9.5rem)_minmax(0,1fr)] gap-x-3 border-b border-kumo-hairline py-2 last:border-0"
          >
            <span className="tabular-nums text-kumo-subtle">{t("importLine", { n: one.row })}</span>
            <span className="truncate font-mono">{one.code}</span>
            <span className="flex min-w-0 flex-col gap-0.5">
              {one.fields.length > 0 ? (
                <span>
                  <span className="text-kumo-subtle">{t("importChangeSet")}: </span>
                  <span className="font-mono break-words">{one.fields.join(", ")}</span>
                </span>
              ) : null}
              {one.cleared.length > 0 ? (
                <span>
                  <span className="text-kumo-subtle">{t("importChangeCleared")}: </span>
                  <span className="font-mono break-words">{one.cleared.join(", ")}</span>
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {report.toUpdate > report.changes.length ? (
        <p className="mt-1 text-sm text-kumo-subtle">{t("importMorePeople", { n: report.toUpdate - report.changes.length })}</p>
      ) : null}
    </div>
  );
}

/** The directory's file work: export, the template built from today's catalogues, and the two-step import (KEHOACH 9.20). */
export function DirectoryFiles({ query, filtered, mayWrite }: { query: string; filtered: boolean; mayWrite: boolean }) {
  const t = useTranslations("employees");
  const common = useTranslations("common");
  const faultName = useTranslations("importFaults");
  const warningName = useTranslations("importWarnings");
  const faultOf = useFault();
  const notify = useNotify();
  const cache = useQueryClient();
  const phone = usePhone();
  const picker = useRef<HTMLInputElement>(null);

  const [choosing, setChoosing] = useState(false);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [importFault, setImportFault] = useState<string | null>(null);

  const check = useMutation({
    mutationFn: (file: Upload) => send(file, false),
    onSuccess: (seen) => setReport(seen),
    onError: (fell: unknown) => setImportFault(faultOf(fell)),
  });

  const apply = useMutation({
    mutationFn: () => send(upload as Upload, true),
    onSuccess: (done) => {
      setReport(null);
      setUpload(null);
      notify.done(t("importDone", { created: done.toCreate, updated: done.toUpdate }));
      for (const key of ["employees", "users", "compensation", "shifts", "enrollments"]) {
        void cache.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (fell: unknown) => setImportFault(faultOf(fell)),
  });

  const download = useMutation({
    mutationFn: async () => save(await fetchFile(`/employees/export${query}`), "employees.xlsx"),
    onSuccess: () => notify.done(t("exported")),
    onError: notify.failed,
  });

  const template = useMutation({
    mutationFn: async () => save(await fetchFile("/employees/import/template"), "employees-template.xlsx"),
    onSuccess: () => notify.done(t("templateSaved")),
    onError: notify.failed,
  });

  function takeFile(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    setChoosing(false);
    setImportFault(null);
    setReport(null);
    const type = file.name.toLowerCase().endsWith(".xlsx") ? XLSX_MIME : CSV_MIME;
    void file.arrayBuffer().then((bytes) => {
      setUpload({ bytes, type });
      check.mutate({ bytes, type });
    });
  }

  const faultText = (code: string) => (faultName.has(code as never) ? faultName(code as never) : code);
  const warningText = (code: string) => (warningName.has(code as never) ? warningName(code as never) : code);
  const writes = report ? report.toCreate + report.toUpdate : 0;
  const extras = report
    ? [
        report.shiftsToAssign > 0 ? t("importShifts", { count: report.shiftsToAssign }) : null,
        report.consentsToRecord > 0 ? t("importConsents", { count: report.consentsToRecord }) : null,
        report.kiosksToAssign > 0 ? t("importKiosks", { count: report.kiosksToAssign }) : null,
        report.loginsToOpen > 0 ? t("importLogins", { count: report.loginsToOpen }) : null,
        report.payKept > 0 ? t("importPayKept", { count: report.payKept }) : null,
      ].filter((one): one is string => one !== null)
    : [];

  return (
    <>
      <Button
        variant="secondary"
        icon={DownloadSimpleIcon}
        loading={download.isPending}
        onClick={() => download.mutate()}
        className="w-full justify-start"
      >
        {filtered ? t("exportFiltered") : t("export")}
      </Button>
      {mayWrite && phone ? (
        <p className="m-0 flex items-start gap-2 text-sm text-kumo-subtle">
          <DesktopIcon className="mt-0.5 shrink-0" aria-hidden />
          {t("importDeskOnly")}
        </p>
      ) : null}
      {mayWrite && !phone ? (
        <>
          <Button
            variant="secondary"
            icon={UploadSimpleIcon}
            loading={check.isPending}
            onClick={() => setChoosing(true)}
            className="w-full justify-start"
          >
            {t("import")}
          </Button>
          <Button
            variant="secondary"
            icon={FileArrowDownIcon}
            loading={template.isPending}
            onClick={() => template.mutate()}
            className="w-full justify-start"
          >
            {t("importTemplate")}
          </Button>
          <input
            ref={picker}
            type="file"
            accept={`.xlsx,.csv,${XLSX_MIME},${CSV_MIME}`}
            className="hidden"
            onChange={takeFile}
          />
        </>
      ) : null}

      <LayerDialog.Root open={choosing} onOpenChange={setChoosing}>
        <LayerDialog.Content size="lg" closeLabel={common("close")}>
          <LayerDialog.Title>{t("import")}</LayerDialog.Title>
          <LayerDialog.Description>{t("importLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-5">
              <Banner
                variant="secondary"
                icon={<FileXlsIcon weight="fill" />}
                description={t("importTemplateLead")}
                action={
                  <Banner.Action
                    variant="secondary"
                    icon={<FileArrowDownIcon />}
                    loading={template.isPending}
                    onClick={() => template.mutate()}
                  >
                    {t("importTemplate")}
                  </Banner.Action>
                }
              />
              <div>
                <p className="m-0 font-medium">{t("importColumnsTitle")}</p>
                <p className="mt-1 mb-3 text-kumo-subtle">{t("importBlankRule")}</p>
                <dl className="m-0 grid gap-x-6 sm:grid-cols-[13rem_minmax(0,1fr)]">
                  {(Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]).map((one) => (
                    <div key={one} className="contents">
                      <dt className="border-kumo-hairline pt-2 font-mono text-sm break-words sm:border-t sm:pb-2">{COLUMNS[one]}</dt>
                      <dd className="m-0 border-b border-kumo-hairline pb-2 text-kumo-subtle sm:border-t sm:border-b-0 sm:pt-2">
                        {t(`importFormat_${one}`)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary loading={check.isPending} onClick={() => picker.current?.click()}>
              {t("importPick")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>

      <LayerDialog.Root
        open={report !== null || importFault !== null}
        onOpenChange={(next) => {
          if (!next) {
            setReport(null);
            setImportFault(null);
          }
        }}
        dismissDisabled={apply.isPending}
      >
        <LayerDialog.Content size="lg" closeLabel={common("close")}>
          <LayerDialog.Title>{t("importCheckTitle")}</LayerDialog.Title>
          <LayerDialog.Description>
            {report
              ? t("importDry", { rows: report.rows, created: report.toCreate, updated: report.toUpdate, unchanged: report.unchanged })
              : importFault}
          </LayerDialog.Description>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              {extras.length > 0 ? (
                <ul className="m-0 flex list-disc flex-col gap-1 ps-5 text-kumo-subtle">
                  {extras.map((one) => (
                    <li key={one}>{one}</li>
                  ))}
                </ul>
              ) : null}
              {report && report.changes.length > 0 ? <Changes report={report} /> : null}
              {report && report.faults.length === 0 && writes === 0 ? (
                <p className="m-0 text-kumo-subtle">{t("importNothing")}</p>
              ) : null}
              {report && report.faults.length > 0 ? (
                <div>
                  <Banner
                    variant="error"
                    size="sm"
                    icon={<WarningCircleIcon weight="fill" />}
                    title={t("importFaults", { n: report.faults.length })}
                  />
                  <Lines items={report.faults} text={faultText} />
                </div>
              ) : null}
              {report && report.warnings.length > 0 ? (
                <div>
                  <Banner
                    variant="alert"
                    size="sm"
                    icon={<WarningIcon weight="fill" />}
                    title={t("importWarningsTitle", { n: report.warnings.length })}
                  />
                  <Lines items={report.warnings} text={warningText} />
                </div>
              ) : null}
            </div>
          </LayerDialog.Body>
          {report && report.faults.length === 0 && writes > 0 ? (
            <LayerDialog.Actions dismissLabel={common("cancel")}>
              <LayerDialog.Actions.Primary loading={apply.isPending} onClick={() => apply.mutate()}>
                {t("importApplyN", { count: writes })}
              </LayerDialog.Actions.Primary>
            </LayerDialog.Actions>
          ) : null}
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}
