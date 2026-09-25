"use client";

import { Tabs } from "@cloudflare/kumo";
import { MonitorIcon, MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { applyTheme, asTheme, readTheme, THEMES, type Theme } from "@/lib/theme";

const FACE = {
  system: { icon: MonitorIcon, key: "themeSystem" },
  light: { icon: SunIcon, key: "themeLight" },
  dark: { icon: MoonIcon, key: "themeDark" },
} as const;

/** Light, dark or the system's; `compact` shows the icons alone, named for screen readers. */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const t = useTranslations("settings");
  const [theme, setTheme] = useState<Theme>("system");

  // The server has no cookie jar to read, so the stored choice lands after mount.
  useEffect(() => setTheme(readTheme()), []);

  return (
    <Tabs
      variant="segmented"
      size={compact ? "sm" : "base"}
      value={theme}
      onValueChange={(next) => {
        const picked = asTheme(next);
        setTheme(picked);
        applyTheme(picked);
      }}
      tabs={THEMES.map((one) => {
        const Icon = FACE[one].icon;
        return {
          value: one,
          label: (
            <span className="flex items-center gap-2" title={compact ? t(FACE[one].key) : undefined}>
              <Icon size={compact ? 14 : 16} aria-hidden />
              <span className={compact ? "sr-only" : undefined}>{t(FACE[one].key)}</span>
            </span>
          ),
        };
      })}
    />
  );
}
