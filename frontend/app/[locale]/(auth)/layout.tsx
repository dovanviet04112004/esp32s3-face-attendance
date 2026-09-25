"use client";

import { Tabs } from "@cloudflare/kumo";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Suspense, useTransition, type ReactNode } from "react";

import { ThemeToggle } from "@/components/ui/theme-toggle";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing, type Locale } from "@/i18n/routing";

/** The other language for the same door, query kept: a set-password link carries its token there. */
function LanguageSwitch() {
  const t = useTranslations("doors");
  const names = useTranslations("settings");
  const locale = useLocale();
  const here = usePathname();
  const query = useSearchParams().toString();
  const router = useRouter();
  const [moving, startMoving] = useTransition();

  return (
    <Tabs
      variant="segmented"
      size="sm"
      value={locale}
      onValueChange={(next) => {
        if (next === locale || !routing.locales.includes(next as Locale)) {
          return;
        }
        startMoving(() => router.replace(query ? `${here}?${query}` : here, { locale: next as Locale }));
      }}
      tabs={routing.locales.map((code) => ({
        value: code,
        label: (
          <span lang={code} title={names(code)} className={moving ? "opacity-60" : undefined}>
            {t(code)}
          </span>
        ),
      }))}
    />
  );
}

/** The four doors stand outside the dashboard frame as one quiet column (KEHOACH 9.12). */
export default function AuthLayout({ children }: { children: ReactNode }) {
  const app = useTranslations("app");
  const here = usePathname();
  return (
    <div className="flex min-h-svh flex-col bg-kumo-canvas">
      <title>{app("name")}</title>
      <header className="flex items-center gap-2.5 px-6 pt-[calc(1.5rem+env(safe-area-inset-top))] sm:px-8">
        <img src="/logo.svg" alt="" width={28} height={28} className="shrink-0" />
        <span className="text-lg font-semibold text-kumo-default">{app("name")}</span>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center px-6 pt-10 pb-[12svh]">
        <div key={here} className="flex w-full max-w-[400px] flex-col motion-enter">
          {children}
        </div>
      </main>
      <footer className="flex flex-wrap items-center justify-between gap-3 px-6 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:px-8">
        <Suspense fallback={null}>
          <LanguageSwitch />
        </Suspense>
        <ThemeToggle compact />
      </footer>
    </div>
  );
}
