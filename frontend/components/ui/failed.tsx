"use client";

import { Banner } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";

/** A read that failed says what to do about it, in the section that failed, and the rest of the page stays. */
export function Failed({ onRetry }: { onRetry?: () => void }) {
  const t = useTranslations("common");
  return (
    <Banner
      variant="error"
      icon={<WarningCircleIcon weight="fill" />}
      title={t("failed")}
      description={t("failedHint")}
      action={onRetry ? <Banner.Action onClick={onRetry}>{t("retry")}</Banner.Action> : undefined}
    />
  );
}
