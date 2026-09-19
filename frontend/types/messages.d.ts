import type viMessages from "../messages/vi.json";

/** vi.json is the shape every other catalogue has to match, so a key missing
 *  from en.json is a tsc error rather than a raw key on a customer's screen
 *  (CLAUDE.md 3.1 rule 1).
 */
declare module "next-intl" {
  interface AppConfig {
    Messages: typeof viMessages;
    Locale: "vi" | "en";
  }
}
