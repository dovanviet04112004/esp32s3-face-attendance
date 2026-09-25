"use client";

import { Button, LinkButton } from "@cloudflare/kumo";
import { ArrowClockwiseIcon, HouseIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";

/** The system's own page for a crash below the root layout, in the reader's language (KEHOACH 9.21.6). */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const t = useTranslations("errorPage");
  const common = useTranslations("common");
  const app = useTranslations("app");

  return (
    <div className="flex min-h-svh flex-col bg-kumo-canvas">
      <title>{`${t("title")} · ${app("name")}`}</title>
      <header className="flex items-center gap-2.5 px-6 pt-[calc(1.5rem+env(safe-area-inset-top))] sm:px-8">
        <img src="/logo.svg" alt="" width={28} height={28} className="shrink-0" />
        <span className="text-lg font-semibold text-kumo-default">{app("name")}</span>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center px-6 pt-10 pb-[12svh]">
        <div className="flex w-full max-w-[400px] flex-col gap-6 motion-enter">
          <div className="flex flex-col gap-2">
            <h1 className="m-0 text-3xl font-semibold text-kumo-default">{t("title")}</h1>
            <p className="text-lg text-pretty text-kumo-subtle">{t("lead")}</p>
          </div>
          <div className="flex flex-col gap-3">
            <Button variant="primary" size="lg" icon={ArrowClockwiseIcon} onClick={retry} className="w-full justify-center">
              {common("retry")}
            </Button>
            <LinkButton href="/" variant="secondary" size="lg" icon={HouseIcon} className="w-full justify-center">
              {t("home")}
            </LinkButton>
          </div>
          {error.digest ? (
            <p className="font-mono text-sm text-kumo-subtle">{t("reference", { digest: error.digest })}</p>
          ) : null}
        </div>
      </main>
    </div>
  );
}
