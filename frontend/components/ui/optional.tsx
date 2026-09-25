"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

/** Builds a field label that says the field may stay empty, in the reader's language.
 *  Pass the result as `label` and leave `required` unset: Kumo's `required={false}` prints English.
 */
export function useOptional(): (label: ReactNode) => ReactNode {
  const common = useTranslations("common");
  return (label) => (
    <>
      {label} <span className="font-normal text-kumo-subtle">{common("optional")}</span>
    </>
  );
}
