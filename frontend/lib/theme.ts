export type Theme = "system" | "light" | "dark";

export const THEMES: Theme[] = ["system", "light", "dark"];

const kStore = "theme";

// color-scheme paints the canvas with no stylesheet loaded (KEHOACH 9.12).
export const kThemeScript = `try{var r=document.documentElement,t=localStorage.getItem('${kStore}');if(t==='dark'||t==='light'){r.dataset.theme=t;r.style.colorScheme=t}else{r.style.colorScheme='light dark'}}catch(e){}`;

export function readTheme(): Theme {
  try {
    const raw = window.localStorage.getItem(kStore);
    return raw === "dark" || raw === "light" ? raw : "system";
  } catch {
    return "system";
  }
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
    root.style.colorScheme = "light dark";
  } else {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
  }
  paintChrome(theme);
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
