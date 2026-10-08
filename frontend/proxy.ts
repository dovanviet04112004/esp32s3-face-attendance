import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";

import { routing } from "./i18n/routing";
import { SIGNED_COOKIE, SIGNED_OUT_PAGES, markOf } from "./lib/auth";
import { homeOf, kHomeCookie } from "./lib/theme";

const intl = createMiddleware(routing);

// The form for a browser that signed out on purpose, never the form for one signed in (KEHOACH 9.12),
// and the home this device opened last for a bare address (KEHOACH 9.21.6).
function onwardOf(landing: URL, request: NextRequest): string | null {
  const [, locale = "", page = ""] = landing.pathname.split("/");
  if (!(routing.locales as readonly string[]).includes(locale)) {
    return null;
  }
  const mark = markOf(request.cookies.get(SIGNED_COOKIE)?.value);
  const home = homeOf(request.cookies.get(kHomeCookie)?.value);
  if (mark === "out" && !SIGNED_OUT_PAGES.has(page)) {
    return `/${locale}/login`;
  }
  if (mark === "in" && page === "login") {
    return `/${locale}${home ?? ""}`;
  }
  return page === "" && home !== null ? `/${locale}${home}${landing.search}` : null;
}

export default function proxy(request: NextRequest) {
  const answer = intl(request);
  const moved = answer.headers.get("location");
  const landing = moved ? new URL(moved, request.url) : request.nextUrl;
  const onwardTo = onwardOf(landing, request);
  if (onwardTo === null) {
    return answer;
  }
  const onward = NextResponse.redirect(new URL(onwardTo, request.url));
  answer.cookies.getAll().forEach((cookie) => onward.cookies.set(cookie));
  return onward;
}

export const config = {
  // Everything but Next's own assets and anything with a file extension, so a
  // bare "/" still opens and /favicon.ico is not rewritten to /vi/favicon.ico.
  matcher: "/((?!api|_next|_vercel|.*\\..*).*)",
};
