"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, type ComponentType } from "react";

import { cn } from "@/lib/cn";
import { applyTheme, readTheme, THEMES, type Theme } from "@/lib/theme";

interface Face {
  icon: ComponentType<{ className?: string }>;
  key: "themeSystem" | "themeLight" | "themeDark";
}

const FACE: Record<Theme, Face> = {
  system: { icon: Monitor, key: "themeSystem" },
  light: { icon: Sun, key: "themeLight" },
  dark: { icon: Moon, key: "themeDark" },
};

export function ThemeToggle() {
  const t = useTranslations("settings");
  const [theme, setTheme] = useState<Theme>("system");

  // The server has no localStorage, so the stored choice lands after mount.
  useEffect(() => setTheme(readTheme()), []);

  function choose(next: Theme): void {
    setTheme(next);
    applyTheme(next);
  }

  return (
    <div className="inline-flex rounded-lg border border-(--color-line) p-1" role="group">
      {THEMES.map((one) => {
        const { icon: Icon, key } = FACE[one];
        const on = theme === one;
        return (
          <button
            key={one}
            type="button"
            aria-current={on}
            onClick={() => choose(one)}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm pointer-coarse:min-h-11",
              on ? "bg-(--color-accent) text-white" : "text-(--color-muted) hover:bg-(--color-ground)",
            )}
          >
            <Icon className="size-4" />
            {t(key)}
          </button>
        );
      })}
    </div>
  );
}
