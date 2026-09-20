export type Theme = "system" | "light" | "dark";

export const THEMES: Theme[] = ["system", "light", "dark"];

const kStore = "theme";

/** Runs in head so the first paint is already the chosen theme (KEHOACH 9.12). */
export const kThemeScript = `try{var t=localStorage.getItem('${kStore}');if(t==='dark'||t==='light'){document.documentElement.dataset.theme=t}}catch(e){}`;

export function readTheme(): Theme {
  try {
    const raw = window.localStorage.getItem(kStore);
    return raw === "dark" || raw === "light" ? raw : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }
  try {
    if (theme === "system") {
      window.localStorage.removeItem(kStore);
    } else {
      window.localStorage.setItem(kStore, theme);
    }
  } catch {
    return;
  }
}
