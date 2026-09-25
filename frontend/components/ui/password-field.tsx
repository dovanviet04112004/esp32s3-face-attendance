"use client";

import { InputGroup } from "@cloudflare/kumo";
import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useState, type ComponentProps } from "react";

interface Props extends Omit<ComponentProps<typeof InputGroup.Input>, "type"> {
  label: string;
  description?: string;
  error?: string;
  /** Several fields on one form reveal together when the form holds this. */
  shown?: boolean;
  onShownChange?: (shown: boolean) => void;
  /** A second field that follows the first one's toggle carries no button of its own. */
  toggle?: boolean;
}

/** A password box that can be read back: a phone keyboard offers no other way to find a typo. */
export function PasswordField({ label, description, error, shown, onShownChange, toggle = true, ...input }: Props) {
  const common = useTranslations("common");
  const [own, setOwn] = useState(false);
  const visible = shown ?? own;
  const flip = onShownChange ?? setOwn;

  return (
    <InputGroup label={label} description={description} error={error ? { message: error, match: true } : undefined}>
      <InputGroup.Input {...input} type={visible ? "text" : "password"} />
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
  );
}
