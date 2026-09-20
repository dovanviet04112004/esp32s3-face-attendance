"use client";

import { isAxiosError } from "axios";
import { useTranslations } from "next-intl";

import type viMessages from "../messages/vi.json";

type ErrorCode = keyof (typeof viMessages)["errors"];

function codeOf(fell: unknown): string {
  if (!isAxiosError(fell)) {
    return "";
  }
  // No response at all is the network, not the api.
  if (!fell.response) {
    return "NETWORK_UNREACHABLE";
  }
  const body = fell.response.data as { message?: string | string[] } | undefined;
  const held = body?.message;
  return Array.isArray(held) ? (held[0] ?? "") : (held ?? "");
}

/** The one place an api code becomes a sentence (CLAUDE.md 3.1 rule 2). */
export function useFault(): (fell: unknown) => string {
  const t = useTranslations("errors");
  const common = useTranslations("common");
  return (fell) => {
    const code = codeOf(fell);
    return t.has(code as ErrorCode) ? t(code as ErrorCode) : common("failed");
  };
}
