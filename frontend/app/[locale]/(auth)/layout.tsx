"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

/** The four doors stand outside the dashboard frame, one card centred like Cloudflare's sign-in (KEHOACH 4.7). */
export default function AuthLayout({ children }: { children: ReactNode }) {
  const app = useTranslations("app");
  return (
    <main className="grid min-h-svh place-items-center bg-kumo-canvas px-4 py-10">
      <title>{app("name")}</title>
      <div className="flex w-full max-w-sm flex-col gap-6">
        <p className="flex items-center justify-center gap-2 text-lg font-semibold text-kumo-default">
          <img src="/logo.svg" alt="" width={24} height={24} />
          {app("name")}
        </p>
        {children}
      </div>
    </main>
  );
}
