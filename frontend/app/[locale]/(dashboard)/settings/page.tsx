"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";

import { NoticePreferences } from "@/components/notifications/notice-prefs";
import { PushSwitch } from "@/components/notifications/push-switch";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing, type Locale } from "@/i18n/routing";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";

export default function SettingsPage() {
  const t = useTranslations("settings");
  const notices = useTranslations("notices");
  const locale = useLocale();
  const here = usePathname();
  const router = useRouter();
  const role = useSession((s) => s.role);
  const [moving, startMoving] = useTransition();

  function choose(next: Locale) {
    if (next === locale) {
      return;
    }
    // Same page, other language: the locale rides on the URL, so this is a move.
    startMoving(() => router.replace(here, { locale: next }));
  }

  return (
    <section className="max-w-xl">
      <h1 className="text-lg font-semibold">{t("title")}</h1>

      <div className="mt-6 rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
        <h2 className="text-sm font-medium">{t("languageTitle")}</h2>
        <p className="mt-1 text-sm text-(--color-muted)">{t("languageLead")}</p>
        <div className="mt-4 inline-flex rounded-lg border border-(--color-line) p-1" role="group">
          {routing.locales.map((code) => (
            <button
              key={code}
              type="button"
              lang={code}
              aria-current={code === locale}
              disabled={moving}
              onClick={() => choose(code)}
              className={cn(
                "rounded-md px-4 py-1.5 text-sm disabled:opacity-60 pointer-coarse:min-h-11",
                code === locale
                  ? "bg-(--color-accent) text-white"
                  : "text-(--color-muted) hover:bg-(--color-ground)",
              )}
            >
              {t(code)}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
        <h2 className="text-sm font-medium">{t("themeTitle")}</h2>
        <p className="mt-1 text-sm text-(--color-muted)">{t("themeLead")}</p>
        <div className="mt-4">
          <ThemeToggle />
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
        <h2 className="text-sm font-medium">{notices("pushTitle")}</h2>
        <p className="mt-1 text-sm text-(--color-muted)">{notices("pushLead")}</p>
        <div className="mt-4">
          <PushSwitch />
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
        <h2 className="text-sm font-medium">{notices("prefsTitle")}</h2>
        <p className="mt-1 text-sm text-(--color-muted)">{notices("prefsLead")}</p>
        <div className="mt-4">
          <NoticePreferences />
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
        <h2 className="text-sm font-medium">{t("accountTitle")}</h2>
        <p className="mt-2 text-sm text-(--color-muted)">
          {t("role")}: <span className="font-mono text-(--color-ink)">{role ?? "—"}</span>
        </p>
      </div>
    </section>
  );
}
