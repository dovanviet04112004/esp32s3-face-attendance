"use client";

import { Input } from "@cloudflare/kumo";
import { useTranslations } from "next-intl";
import { useState } from "react";

const kDigits = 6;
const kBackupLength = 11;

/** One box for the six digits, or for a backup code once the person has no phone at hand (KEHOACH 9.4). */
export function CodeField({
  value,
  onChange,
  allowBackup = true,
  autoFocus = true,
}: {
  value: string;
  onChange: (next: string) => void;
  allowBackup?: boolean;
  autoFocus?: boolean;
}) {
  const t = useTranslations("mfa");
  const [backup, setBackup] = useState(false);

  function switchKind(): void {
    setBackup(!backup);
    onChange("");
  }

  return (
    <div className="flex flex-col gap-2">
      <Input
        key={backup ? "backup" : "code"}
        size="lg"
        label={backup ? t("backupLabel") : t("codeLabel")}
        description={backup ? t("backupHint") : undefined}
        inputMode={backup ? "text" : "numeric"}
        pattern={backup ? undefined : "[0-9]*"}
        autoComplete="one-time-code"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        autoFocus={autoFocus}
        required
        maxLength={backup ? kBackupLength : kDigits}
        value={value}
        onChange={(event) => onChange(backup ? event.target.value : event.target.value.replace(/\D/g, ""))}
        className="w-full font-mono tabular-nums tracking-widest"
      />
      {allowBackup ? (
        <button type="button" onClick={switchKind} className="self-start text-sm text-kumo-link underline-offset-2 hover:underline">
          {backup ? t("useApp") : t("useBackup")}
        </button>
      ) : null}
    </div>
  );
}
