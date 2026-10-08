"use client";

import { Input } from "@cloudflare/kumo";
import { useTranslations } from "next-intl";
import { useState } from "react";

const kDigits = 6;
const kBackupLength = 11;

// Cut after the clean-up, never by maxLength: the browser would cut a pasted "767 123" to "767 12" first.
function tidy(typed: string, backup: boolean): string {
  return backup ? typed.replace(/\s/g, "").slice(0, kBackupLength) : typed.replace(/\D/g, "").slice(0, kDigits);
}

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
        value={value}
        onChange={(event) => onChange(tidy(event.target.value, backup))}
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
