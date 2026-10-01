"use client";

import { Button } from "@cloudflare/kumo";
import { CopyIcon, DownloadSimpleIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";

import { useNotify } from "@/components/ui/notify";

/** Ten backup codes, shown once: the server keeps only their hashes (KEHOACH 9.4). */
export function BackupCodes({ codes }: { codes: string[] }) {
  const t = useTranslations("mfa");
  const notify = useNotify();
  const text = `${codes.join("\n")}\n`;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      notify.done(t("codesCopied"));
    } catch {
      notify.failed(t("copyBlocked"));
    }
  }

  function download(): void {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = t("codesFile");
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-3">
      <ol className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-kumo-line bg-kumo-tint px-4 py-3 font-mono text-base tabular-nums">
        {codes.map((one) => (
          <li key={one}>{one}</li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" icon={CopyIcon} onClick={() => void copy()}>
          {t("copy")}
        </Button>
        <Button variant="secondary" icon={DownloadSimpleIcon} onClick={download}>
          {t("download")}
        </Button>
      </div>
    </div>
  );
}
