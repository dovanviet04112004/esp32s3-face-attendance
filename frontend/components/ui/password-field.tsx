"use client";

import { InputGroup } from "@cloudflare/kumo";
import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useState, type ComponentProps, type ReactNode } from "react";

interface Props extends Omit<ComponentProps<typeof InputGroup.Input>, "type"> {
  label: string;
  description?: string;
  error?: string;
  size?: "base" | "lg";
  /** At the end of the label row, such as the way back in for a forgotten password. */
  labelAside?: ReactNode;
  /** Several fields on one form reveal together when the form holds this. */
  shown?: boolean;
  onShownChange?: (shown: boolean) => void;
  /** A second field that follows the first one's toggle carries no button of its own. */
  toggle?: boolean;
  /** A meter under a new password; a hint only, the server holds the rules (KEHOACH 9.4). */
  strength?: boolean;
}

const LEVELS = ["tooShort", "weak", "fair", "good", "strong"] as const;
const FILL = ["bg-kumo-danger", "bg-kumo-danger", "bg-kumo-warning", "bg-kumo-success", "bg-kumo-success"];
// A run of one character or of a keyboard row is a pattern a guesser tries, not length.
const PATTERN = /(.)\1{3,}|0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf|zxcv/i;

function strengthOf(password: string): number {
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((one) => one.test(password)).length;
  const length = password.length >= 20 ? 3 : password.length >= 16 ? 2 : password.length >= 12 ? 1 : 0;
  if (length === 0) {
    return 0;
  }
  return Math.max(1, Math.min(4, length + (kinds >= 3 ? 1 : 0) - (PATTERN.test(password) ? 1 : 0)));
}

function Strength({ password }: { password: string }) {
  const t = useTranslations("common");
  const score = strengthOf(password);
  return (
    <div className="mt-2 flex items-center gap-3" aria-live="polite">
      <div className="flex flex-1 gap-1" aria-hidden>
        {[1, 2, 3, 4].map((step) => (
          <span key={step} className={`h-1 flex-1 rounded-full ${step <= score ? FILL[score] : "bg-kumo-hairline"}`} />
        ))}
      </div>
      <span className="text-sm whitespace-nowrap text-kumo-subtle">{t(`strength_${LEVELS[score]}`)}</span>
    </div>
  );
}

/** A password box that can be read back: a phone keyboard offers no other way to find a typo. */
export function PasswordField({
  label,
  description,
  error,
  size,
  labelAside,
  shown,
  onShownChange,
  toggle = true,
  strength = false,
  ...input
}: Props) {
  const common = useTranslations("common");
  const [own, setOwn] = useState(false);
  const visible = shown ?? own;
  const flip = onShownChange ?? setOwn;

  return (
    <div className="relative">
      <InputGroup
        size={size}
        label={label}
        description={description}
        error={error ? { message: error, match: true } : undefined}
      >
        <InputGroup.Input aria-label={label} {...input} type={visible ? "text" : "password"} />
        {toggle ? (
          <InputGroup.Addon align="end">
            <InputGroup.Button
              shape="square"
              className="text-kumo-subtle"
              icon={visible ? EyeSlashIcon : EyeIcon}
              aria-label={visible ? common("hidePassword") : common("showPassword")}
              aria-pressed={visible}
              onClick={() => flip(!visible)}
            />
          </InputGroup.Addon>
        ) : null}
      </InputGroup>
      {labelAside ? <div className="absolute end-0 top-0 text-base leading-normal">{labelAside}</div> : null}
      {strength && input.value ? <Strength password={String(input.value)} /> : null}
    </div>
  );
}
