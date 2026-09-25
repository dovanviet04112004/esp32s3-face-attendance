"use client";

import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { useState, type ComponentPropsWithRef } from "react";

import { cn } from "@/lib/cn";

const field = cn(
  "h-10 w-full rounded-lg border border-(--color-field) bg-(--color-surface) px-3 text-sm",
  "pointer-coarse:h-11 placeholder:text-(--color-muted)",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-accent)",
);

export function Input({ className, ...rest }: ComponentPropsWithRef<"input">) {
  return <input className={cn(field, className)} {...rest} />;
}

interface SecretProps extends Omit<ComponentPropsWithRef<"input">, "type"> {
  showLabel: string;
  hideLabel: string;
}

/** A password box whose contents can be checked, because a phone keyboard
 *  offers no other way to find the typo in twelve hidden characters.
 */
export function PasswordInput({ className, showLabel, hideLabel, ...rest }: SecretProps) {
  const [shown, setShown] = useState(false);
  const Icon = shown ? EyeSlashIcon : EyeIcon;
  return (
    <div className={cn("relative", className)}>
      <input type={shown ? "text" : "password"} className={cn(field, "pe-11")} {...rest} />
      <button
        type="button"
        aria-label={shown ? hideLabel : showLabel}
        aria-pressed={shown}
        onClick={() => setShown(!shown)}
        className="absolute inset-y-0 end-0 grid w-11 place-items-center rounded-e-lg text-(--color-muted) hover:text-(--color-ink) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-accent)"
      >
        <Icon className="size-4" aria-hidden />
      </button>
    </div>
  );
}
