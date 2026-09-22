import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";

import type enMessages from "../messages/en.json";
import type viMessages from "../messages/vi.json";
import { routing } from "./routing";

type Catalogue = Record<string, Record<string, string>>;

type Keys<T extends Catalogue> = {
  [K in keyof T]: `${K & string}.${keyof T[K] & string}`;
}[keyof T];

type CatalogueDrift =
  | Exclude<Keys<typeof viMessages>, Keys<typeof enMessages>>
  | Exclude<Keys<typeof enMessages>, Keys<typeof viMessages>>;

// Any key named here is in one catalogue only, and will not compile (CLAUDE.md 3.1).
const cataloguesAgree: [CatalogueDrift] extends [never] ? true : CatalogueDrift = true;
void cataloguesAgree;

export default getRequestConfig(async ({ requestLocale }) => {
  const asked = await requestLocale;
  const locale = hasLocale(routing.locales, asked) ? asked : routing.defaultLocale;
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
    // next-intl ships no named formats, so asking for one it does not hold
    // throws and the cell renders nothing.
    formats: {
      dateTime: {
        medium: { dateStyle: "medium", timeStyle: "short" },
        day: { dateStyle: "medium" },
        clock: { timeStyle: "short" },
      },
    },
  };
});
