import { routing } from "@/i18n/routing";

import { SIGNED_OUT_PAGES, signedOutHere, useSession } from "./auth";
import { chosenLanguage } from "./theme";

interface Shown {
  url: string;
  state: unknown;
}

const kFoldKey = "fold-history";
const kFoldWaitMs = 1_000;

let shown: Shown | null = null;
let foldingIntoSignIn = false;
let folded: (() => void) | null = null;
let go: ((url: string) => void) | null = null;

// Straight to the browser: Next's patched pushState and replaceState act on whatever they write.
function write(how: "pushState" | "replaceState", state: unknown, url: string): void {
  History.prototype[how].call(window.history, state, "", url);
}

function navigationOf(): Navigation | undefined {
  return "navigation" in window ? window.navigation : undefined;
}

function segmentsOf(path: string): { locale: string; page: string } {
  const [, locale = "", page = ""] = path.split("/");
  return { locale, page };
}

function shownLocale(): string {
  const locale = shown ? segmentsOf(new URL(shown.url).pathname).locale : "";
  return locale || segmentsOf(location.pathname).locale;
}

function guard(event: PopStateEvent): void {
  const { locale, page } = segmentsOf(location.pathname);
  if (foldingIntoSignIn) {
    event.stopImmediatePropagation();
    write("replaceState", null, `/${shownLocale()}/login`);
    foldingIntoSignIn = false;
    folded?.();
    return;
  }
  const barred =
    (signedOutHere() && !SIGNED_OUT_PAGES.has(page)) || (useSession.getState().accessToken !== null && page === "login");
  if (barred && shown !== null) {
    event.stopImmediatePropagation();
    write("replaceState", shown.state, shown.url);
    return;
  }
  const chosen = chosenLanguage();
  if (go !== null && chosen !== null && locale !== chosen && (routing.locales as readonly string[]).includes(locale)) {
    event.stopImmediatePropagation();
    const translated = `/${chosen}${location.pathname.slice(locale.length + 1)}${location.search}`;
    write("replaceState", null, translated);
    go(translated);
  }
}

// At import, ahead of Next's own popstate listener: Chrome runs them in the order they are added (KEHOACH 9.12).
if (typeof window !== "undefined") {
  window.addEventListener("popstate", guard, { capture: true });
}

/** Note the page on screen once a navigation has committed; Back or Forward onto a barred page stays on it. */
export function noteShown(): void {
  shown = { url: location.href, state: window.history.state };
}

// One more entry cuts every entry after it; stepping back onto the first leaves Back to the previous site.
async function dropForward(nav: Navigation): Promise<void> {
  write("pushState", null, location.href);
  await nav.back().finished?.catch(() => undefined);
}

function takeFold(): boolean {
  try {
    const held = sessionStorage.getItem(kFoldKey) !== null;
    sessionStorage.removeItem(kFoldKey);
    return held;
  } catch {
    return false;
  }
}

/** Hand the guard Next's own navigation for Back into another language, and finish a fold a page load cut short. */
export function followHistory(navigate: (url: string) => void): () => void {
  go = navigate;
  const nav = navigationOf();
  if (takeFold() && nav) {
    void dropForward(nav);
  }
  return () => {
    go = null;
  };
}

/** Fold this tab's entries of the app into one, the form's, so Back from it leaves the site (KEHOACH 9.12). */
export async function foldIntoSignIn(): Promise<void> {
  const nav = navigationOf();
  const first = nav?.entries()[0];
  if (!nav || !first || first.key === nav.currentEntry?.key) {
    return;
  }
  if (!first.sameDocument) {
    try {
      sessionStorage.setItem(kFoldKey, "1");
    } catch {
      return;
    }
    void nav.traverseTo(first.key).finished?.catch(() => undefined);
    return;
  }
  const landed = new Promise<void>((done) => {
    folded = done;
    setTimeout(done, kFoldWaitMs);
  });
  foldingIntoSignIn = true;
  void nav.traverseTo(first.key).finished?.catch(() => undefined);
  await landed;
  foldingIntoSignIn = false;
  folded = null;
  if (nav.currentEntry?.key === first.key) {
    await dropForward(nav);
  }
}
