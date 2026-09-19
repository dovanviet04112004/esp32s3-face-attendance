import createMiddleware from "next-intl/middleware";

import { routing } from "./i18n/routing";

export default createMiddleware(routing);

export const config = {
  // Everything but Next's own assets and anything with a file extension, so a
  // bare "/" still opens and /favicon.ico is not rewritten to /vi/favicon.ico.
  matcher: "/((?!api|_next|_vercel|.*\\..*).*)",
};
