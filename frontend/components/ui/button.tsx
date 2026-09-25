import { Button as KumoButton, type ButtonProps as KumoButtonProps } from "@cloudflare/kumo";
import type { ButtonHTMLAttributes, ReactNode } from "react";

// The names pages already use, onto Kumo's, until each page imports Kumo's Button itself.
const VARIANT = { solid: "primary", quiet: "secondary", danger: "destructive" } as const;
const SIZE = { md: "base", sm: "sm", touch: "lg", icon: "base" } as const;

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: keyof typeof VARIANT;
  size?: keyof typeof SIZE;
  icon?: KumoButtonProps["icon"];
  loading?: boolean;
  children?: ReactNode;
};

export function Button({ tone = "solid", size = "md", ...rest }: ButtonProps) {
  const kumo = { variant: VARIANT[tone], size: SIZE[size], shape: size === "icon" ? "square" : "base", ...rest };
  return <KumoButton {...(kumo as KumoButtonProps)} />;
}
