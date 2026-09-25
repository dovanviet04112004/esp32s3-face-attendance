import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import "../globals.css";
import { Providers } from "../providers";
import { routing, type Locale } from "@/i18n/routing";
import { isSidebarOpen, kModeScript, kSidebarCookie } from "@/lib/theme";

const sans = Inter({ subsets: ["latin", "vietnamese"], variable: "--font-inter", display: "swap" });

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
  interactiveWidget: "resizes-content",
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
    icons: { icon: "/favicon.ico", apple: "/apple-touch-icon.png" },
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
  const sidebarOpen = isSidebarOpen((await cookies()).get(kSidebarCookie)?.value);
  // data-mode belongs to lib/theme.ts alone, and extensions reach html and body first (KEHOACH 9.12).
  return (
    <html lang={locale} className={sans.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: kModeScript }} />
      </head>
      <body className="min-h-svh font-sans text-base antialiased" suppressHydrationWarning>
        <NextIntlClientProvider>
          <Providers sidebarOpen={sidebarOpen}>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
