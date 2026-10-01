"use client";

import { Banner, Button, LayerDialog } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { BackupCodes } from "@/components/auth/backup-codes";
import { CodeField } from "@/components/auth/code-field";
import { useNotify } from "@/components/ui/notify";
import { Facts } from "@/components/ui/page";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";

const kFewCodes = 3;
const kFormId = "renew-backup-codes";

export interface TwoStepStatus {
  required: boolean;
  enabledAt: string | null;
  backupCodesLeft: number;
}

/** Whether the caller signs in with a code, since when, and how many backup codes are left (KEHOACH 9.4). */
export function useTwoStep() {
  return useQuery({
    queryKey: ["auth", "mfa"],
    queryFn: async () => (await api.get<TwoStepStatus>("/auth/mfa")).data,
  });
}

/** The settings card: when two-step sign-in went on, the codes left, and a fresh set for a working code. */
export function TwoStep({ status }: { status: TwoStepStatus }) {
  const t = useTranslations("mfa");
  const common = useTranslations("common");
  const format = useFormatter();
  const cache = useQueryClient();
  const notify = useNotify();
  const faultOf = useFault();
  const [asking, setAsking] = useState(false);
  const [code, setCode] = useState("");
  const [fault, setFault] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string[] | null>(null);

  const renew = useMutation({
    mutationFn: async (given: string) =>
      (await api.post<{ backupCodes: string[] }>("/auth/mfa/backup-codes", { code: given })).data.backupCodes,
    onSuccess: (codes) => {
      setAsking(false);
      setFresh(codes);
      notify.done(t("renewDone"));
      void cache.invalidateQueries({ queryKey: ["auth", "mfa"] });
    },
    onError: (fell: unknown) => setFault(faultOf(fell)),
  });

  function open(): void {
    setFault(null);
    setCode("");
    setAsking(true);
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    setFault(null);
    renew.mutate(code);
  }

  return (
    <>
      <div className="w-full">
        <Facts
          rows={[
            [t("since"), status.enabledAt ? format.dateTime(new Date(status.enabledAt), "medium") : common("empty")],
            [t("left"), t("leftCount", { count: status.backupCodesLeft })],
          ]}
        />
      </div>
      {status.backupCodesLeft <= kFewCodes ? <p className="text-kumo-warning">{t("fewCodes")}</p> : null}
      <p className="text-kumo-subtle">{t("phone")}</p>
      {fresh ? (
        <div className="flex w-full flex-col gap-3 border-t border-kumo-hairline pt-3">
          <p className="font-medium">{t("codesTitle")}</p>
          <p className="text-kumo-subtle">{t("codesLead")}</p>
          <BackupCodes codes={fresh} />
          <Button variant="primary" className="self-start" onClick={() => setFresh(null)}>
            {t("codesKept")}
          </Button>
        </div>
      ) : (
        <Button variant="secondary" icon={ArrowsClockwiseIcon} onClick={open}>
          {t("renew")}
        </Button>
      )}

      <LayerDialog.Root open={asking} onOpenChange={(next) => !next && setAsking(false)} dismissDisabled={renew.isPending}>
        <LayerDialog.Content closeLabel={common("close")}>
          <LayerDialog.Title>{t("renewTitle")}</LayerDialog.Title>
          <LayerDialog.Description>{t("renewLead")}</LayerDialog.Description>
          <LayerDialog.Body>
            <form id={kFormId} onSubmit={submit} className="flex flex-col gap-4">
              <CodeField value={code} onChange={setCode} />
              {fault ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={fault} /> : null}
            </form>
          </LayerDialog.Body>
          <LayerDialog.Actions dismissLabel={common("cancel")}>
            <LayerDialog.Actions.Primary type="submit" form={kFormId} loading={renew.isPending}>
              {t("renewGo")}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}
