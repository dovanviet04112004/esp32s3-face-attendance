import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";

import { routing, type Locale } from "./i18n/routing";
import { homeOf, kHomeCookie } from "./lib/theme";

const intl = createMiddleware(routing);

function rootOf(path: string): Locale | null {
  const bare = path.replace(/\/$/, "").slice(1);
  return routing.locales.find((locale) => locale === bare) ?? null;
}

/** A bare address goes straight to the home this device opened last (KEHOACH 9.21.6). */
export default function proxy(request: NextRequest) {
  const answer = intl(request);
  const home = homeOf(request.cookies.get(kHomeCookie)?.value);
  if (home === null) {
    return answer;
  }
  const moved = answer.headers.get("location");
  const landing = moved ? new URL(moved, request.url) : request.nextUrl;
  const locale = rootOf(landing.pathname);
  if (locale === null) {
    return answer;
  }
  const onward = NextResponse.redirect(new URL(`/${locale}${home}${landing.search}`, request.url));
  answer.cookies.getAll().forEach((cookie) => onward.cookies.set(cookie));
  return onward;
}

export const config = {
  // Everything but Next's own assets and anything with a file extension, so a
  // bare "/" still opens and /favicon.ico is not rewritten to /vi/favicon.ico.
  matcher: "/((?!api|_next|_vercel|.*\\..*).*)",
};
