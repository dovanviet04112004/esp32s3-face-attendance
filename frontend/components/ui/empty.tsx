"use client";

import { TrayIcon, WarningIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

interface EmptyProps {
  title: string;
  hint?: string;
  action?: ReactNode;
}

export function Empty({ title, hint, action }: EmptyProps) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-(--color-line) bg-(--color-surface) px-6 py-12 text-center">
      <TrayIcon className="size-8 text-(--color-muted)" aria-hidden />
      <p className="mt-3 text-sm font-medium">{title}</p>
      {hint ? <p className="mt-1 max-w-sm text-sm text-(--color-muted)">{hint}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** A failed read says what to do about it, so retry sits inside the state. */
export function Failed({ onRetry }: { onRetry?: () => void }) {
  const t = useTranslations("common");
  return (
    <div
      role="alert"
      className="grid place-items-center rounded-xl border border-(--color-danger) bg-(--color-surface) px-6 py-12 text-center"
    >
      <WarningIcon className="size-8 text-(--color-danger)" aria-hidden />
      <p className="mt-3 text-sm font-medium">{t("failed")}</p>
      <p className="mt-1 max-w-sm text-sm text-(--color-muted)">{t("failedHint")}</p>
      {onRetry ? (
        <Button type="button" tone="quiet" size="sm" className="mt-4" onClick={onRetry}>
          {t("retry")}
        </Button>
      ) : null}
    </div>
  );
}
