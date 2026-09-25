export type Theme = "system" | "light" | "dark";

export const THEMES: Theme[] = ["system", "light", "dark"];

export const kThemeCookie = "theme";

export const kSidebarCookie = "sidebar";

export const kHomeCookie = "home";

const kYearSeconds = 31_536_000;
// A path inside the app: "//host" or a scheme would turn "/" into an open redirect.
const kAppPath = /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
const kDarkQuery = "(prefers-color-scheme: dark)";

export function asTheme(raw: string | undefined): Theme {
  return raw === "dark" || raw === "light" ? raw : "system";
}

/** Kumo turns dark on `data-mode`, not on the browser's scheme, so "system" reads the OS itself. */
function isDark(theme: Theme): boolean {
  return theme === "dark" || (theme === "system" && window.matchMedia(kDarkQuery).matches);
}

/** Kumo's canvas as hex, which is what Android paints the status and navigation bars with. */
export const GROUND = { light: "#fbfbfb", dark: "#030303" } as const;

const kChrome = "data-app-chrome";

/** Runs in head ahead of the first paint, which only a cookie reaches: neither page nor phone bars flash. */
export const kModeScript = `try{var m=document.cookie.match(/(?:^|; )${kThemeCookie}=(\\w+)/),t=m?m[1]:"system",d=t==="dark"||(t!=="light"&&matchMedia("${kDarkQuery}").matches);if(d)document.documentElement.dataset.mode="dark";var c=document.createElement("meta");c.name="theme-color";c.content=d?"${GROUND.dark}":"${GROUND.light}";c.setAttribute("${kChrome}","");document.head.prepend(c)}catch(e){}`;

export function readTheme(): Theme {
  const hit = document.cookie
    .split("; ")
    .find((one) => one.startsWith(`${kThemeCookie}=`));
  return asTheme(hit?.slice(kThemeCookie.length + 1));
}

// The first theme-color in head wins, and a media query cannot see a choice made in the app.
function paintChrome(theme: Theme): void {
  const tag = document.head.querySelector(`meta[${kChrome}]`) ?? document.createElement("meta");
  tag.setAttribute("name", "theme-color");
  tag.setAttribute("content", isDark(theme) ? GROUND.dark : GROUND.light);
  tag.setAttribute(kChrome, "");
  if (document.head.firstElementChild !== tag) {
    document.head.prepend(tag);
  }
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

/** Paint the stored choice onto html, then keep "system" on the OS; returns the unsubscribe.
 *  React re-creates <html> bare when the locale segment changes, so each mount calls this ahead of paint. */
export function followSystem(): () => void {
  const query = window.matchMedia(kDarkQuery);
  const again = () => {
    paintMode(readTheme());
    paintChrome(readTheme());
  };
  paintMode(readTheme());
  paintChrome(readTheme());
  query.addEventListener("change", again);
  return () => query.removeEventListener("change", again);
}

export function isSidebarOpen(raw: string | undefined): boolean {
  return raw !== "collapsed";
}

export function rememberSidebar(open: boolean): void {
  document.cookie = `${kSidebarCookie}=${open ? "open" : "collapsed"}; path=/; max-age=${kYearSeconds}; samesite=lax`;
}

/** The home this device opened last, which "/" moves to on the server; a hint to draw, not a grant (KEHOACH 9.21.6). */
export function homeOf(raw: string | undefined): string | null {
  return raw !== undefined && kAppPath.test(raw) ? raw : null;
}

export function rememberHome(path: string): void {
  if (homeOf(path) !== null) {
    document.cookie = `${kHomeCookie}=${path}; path=/; max-age=${kYearSeconds}; samesite=lax`;
  }
}

export function forgetHome(): void {
  document.cookie = `${kHomeCookie}=; path=/; max-age=0; samesite=lax`;
}
