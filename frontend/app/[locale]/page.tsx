import { hasLocale } from "next-intl";

import { redirect } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

/** The address people type first; the dashboard guard picks login or home (KEHOACH 4.7). */
export default async function LocaleRoot({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect({ href: "/overview", locale: hasLocale(routing.locales, locale) ? locale : routing.defaultLocale });
}
