import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import "../globals.css";
import { Providers } from "../providers";
import { routing, type Locale } from "@/i18n/routing";

interface LocaleParams {
  params: Promise<{ locale: string }>;
}

// The segment is a catch-all, so /robots933456.txt arrives here as a locale.
function known(locale: string): Locale {
  return hasLocale(routing.locales, locale) ? locale : routing.defaultLocale;
}

// env(safe-area-inset-*) stays zero unless the page claims the rounded corners.
export const viewport: Viewport = { viewportFit: "cover" };

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale: known(locale), namespace: "app" });
  return { title: t("name"), description: t("description") };
}

export default async function LocaleLayout({ children, params }: LocaleParams & { children: ReactNode }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);
  return (
    <html lang={locale}>
      <body className="min-h-screen antialiased">
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
