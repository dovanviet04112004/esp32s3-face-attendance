"use client";

import { isAxiosError } from "axios";
import { useTranslations } from "next-intl";

import type viMessages from "../messages/vi.json";

type ErrorCode = keyof (typeof viMessages)["errors"];

export function faultCode(fell: unknown): string {
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

/** The one place an api code becomes a sentence, answered now or kept on a row (CLAUDE.md 3.1 rule 2). */
export function useCodeWords(): (code: string) => string {
  const t = useTranslations("errors");
  const common = useTranslations("common");
  return (code) => (t.has(code as ErrorCode) ? t(code as ErrorCode) : common("failed"));
}

export function useFault(): (fell: unknown) => string {
  const words = useCodeWords();
  return (fell) => words(faultCode(fell));
}
