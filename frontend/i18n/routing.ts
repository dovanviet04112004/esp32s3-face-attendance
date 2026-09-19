import { defineRouting } from "next-intl/routing";

/** The languages the dashboard serves, and the one a bare URL lands on.
 *  Vietnamese leads because the deployment is Vietnamese (CLAUDE.md 3.1).
 */
export const routing = defineRouting({
  locales: ["vi", "en"],
  defaultLocale: "vi",
});

export type Locale = (typeof routing.locales)[number];
