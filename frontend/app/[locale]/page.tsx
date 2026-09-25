"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { useRouter } from "@/i18n/navigation";
import { reopenSession } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { homeFor } from "@/lib/nav";

const kAndroidSplashPx = 300;

/** The address people type first and the installed app opens: only the token knows the role,
 *  so the move to that role's home waits for it rather than bouncing through another page (KEHOACH 9.21.6).
 */
export default function LocaleRoot() {
  const app = useTranslations("app");
  const router = useRouter();

  useEffect(() => {
    const held = useSession.getState().accessToken;
    void (held ? Promise.resolve(held) : reopenSession()).then((token) => {
      if (!token) {
        router.replace("/login");
        return;
      }
      const { role, employeeId } = useSession.getState();
      router.replace(homeFor(role, employeeId !== null));
    });
  }, [router]);

  return (
    <main aria-busy aria-label={app("name")} className="grid min-h-svh place-items-center bg-kumo-canvas">
      <title>{app("name")}</title>
      <img src="/icon-512.png" alt="" width={kAndroidSplashPx} height={kAndroidSplashPx} fetchPriority="high" />
    </main>
  );
}
