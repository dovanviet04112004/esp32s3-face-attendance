export type Theme = "system" | "light" | "dark";

export const THEMES: Theme[] = ["system", "light", "dark"];

// The server renders the choice onto html, and only a cookie reaches it.
export const kThemeCookie = "theme";

const kYearSeconds = 31_536_000;

export function asTheme(raw: string | undefined): Theme {
  return raw === "dark" || raw === "light" ? raw : "system";
}

/** What the browser paints its own canvas from, with no stylesheet needed. */
export function schemeOf(theme: Theme): string {
  return theme === "system" ? "light dark" : theme;
}

export function readTheme(): Theme {
  const hit = document.cookie
    .split("; ")
    .find((one) => one.startsWith(`${kThemeCookie}=`));
  return asTheme(hit?.slice(kThemeCookie.length + 1));
}

const kPicked = "theme-color-picked";

// A media query cannot see a choice made in the app, so this tag carries it.
function paintChrome(theme: Theme): void {
  const held = document.head.querySelector(`meta[data-${kPicked}]`);
  if (theme === "system") {
    held?.remove();
    return;
  }
  const ground = getComputedStyle(document.documentElement)
    .getPropertyValue("--color-ground")
    .trim();
  const tag = held ?? document.createElement("meta");
  tag.setAttribute("name", "theme-color");
  tag.setAttribute("content", ground);
  tag.setAttribute(`data-${kPicked}`, "");
  document.head.append(tag);
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }
  root.style.colorScheme = schemeOf(theme);
  paintChrome(theme);
  const age = theme === "system" ? 0 : kYearSeconds;
  document.cookie = `${kThemeCookie}=${theme}; path=/; max-age=${age}; samesite=lax`;
}
