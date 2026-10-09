"use client";

import { LinkButton } from "@cloudflare/kumo";
import { HouseIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";

/** The system's own page for an address that leads nowhere, in the reader's language (KEHOACH 9.21.6). */
export default function NotFoundPage() {
  const t = useTranslations("notFound");
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
          <LinkButton href="/" variant="primary" size="lg" icon={HouseIcon} className="w-full justify-center">
            {t("home")}
          </LinkButton>
        </div>
      </main>
    </div>
  );
}
