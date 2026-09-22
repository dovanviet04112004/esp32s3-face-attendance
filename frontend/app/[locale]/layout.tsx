import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import "../globals.css";
import { Providers } from "../providers";
import { routing, type Locale } from "@/i18n/routing";
import { asTheme, kThemeCookie, schemeOf } from "@/lib/theme";

interface LocaleParams {
  params: Promise<{ locale: string }>;
}

// The segment is a catch-all, so /robots933456.txt arrives here as a locale.
function known(locale: string): Locale {
  return hasLocale(routing.locales, locale) ? locale : routing.defaultLocale;
}

// env(safe-area-inset-*) stays zero unless the page claims the rounded corners.
export const viewport: Viewport = {
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f8fa" },
    { media: "(prefers-color-scheme: dark)", color: "#141821" },
  ],
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale: known(locale), namespace: "app" });
  // No title here: metadata replaces the element on every move between pages,
  // so the name a tab shows is rendered where the page is known.
  return {
    description: t("description"),
    icons: { icon: "/favicon.ico", apple: "/icon-192.png" },
    manifest: "/manifest.webmanifest",
    appleWebApp: { capable: true, title: t("name"), statusBarStyle: "default" },
  };
}

export default async function LocaleLayout({ children, params }: LocaleParams & { children: ReactNode }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);
  const theme = asTheme((await cookies()).get(kThemeCookie)?.value);
  // Extensions reach html and body first, so a class React never wrote is not
  // a mismatch worth reporting (KEHOACH 9.12).
  return (
    <html
      lang={locale}
      data-theme={theme === "system" ? undefined : theme}
      style={{ colorScheme: schemeOf(theme) }}
      suppressHydrationWarning
    >
      <body className="min-h-screen antialiased" suppressHydrationWarning>
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
