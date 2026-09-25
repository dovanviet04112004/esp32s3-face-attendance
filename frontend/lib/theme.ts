export type Theme = "system" | "light" | "dark";

export const THEMES: Theme[] = ["system", "light", "dark"];

// The server renders the choice onto html, and only a cookie reaches it.
export const kThemeCookie = "theme";

const kYearSeconds = 31_536_000;
const kDarkQuery = "(prefers-color-scheme: dark)";

export function asTheme(raw: string | undefined): Theme {
  return raw === "dark" || raw === "light" ? raw : "system";
}

/** Kumo turns dark on `data-mode`, not on the browser's scheme, so "system" reads the OS itself. */
function isDark(theme: Theme): boolean {
  return theme === "dark" || (theme === "system" && window.matchMedia(kDarkQuery).matches);
}

/** Runs in head, ahead of the first paint: a dark screen never flashes the light page. */
export const kModeScript = `try{var m=document.cookie.match(/(?:^|; )${kThemeCookie}=(\\w+)/),t=m?m[1]:"system";if(t==="dark"||(t!=="light"&&matchMedia("${kDarkQuery}").matches))document.documentElement.dataset.mode="dark"}catch(e){}`;

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
  const ground = getComputedStyle(document.body).backgroundColor;
  const tag = held ?? document.createElement("meta");
  tag.setAttribute("name", "theme-color");
  tag.setAttribute("content", ground);
  tag.setAttribute(`data-${kPicked}`, "");
  document.head.append(tag);
}

function paintMode(theme: Theme): void {
  const root = document.documentElement;
  if (isDark(theme)) {
    root.dataset.mode = "dark";
  } else {
    delete root.dataset.mode;
  }
}

export function applyTheme(theme: Theme): void {
  paintMode(theme);
  paintChrome(theme);
  const age = theme === "system" ? 0 : kYearSeconds;
  document.cookie = `${kThemeCookie}=${theme}; path=/; max-age=${age}; samesite=lax`;
}

/** Keeps "system" on the OS as it turns dark at dusk; returns the unsubscribe. */
export function followSystem(): () => void {
  const query = window.matchMedia(kDarkQuery);
  const again = () => paintMode(readTheme());
  query.addEventListener("change", again);
  return () => query.removeEventListener("change", again);
}
