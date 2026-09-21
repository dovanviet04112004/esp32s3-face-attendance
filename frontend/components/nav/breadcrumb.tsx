"use client";

import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";

import { Link, usePathname } from "@/i18n/navigation";
import { useSession } from "@/lib/auth";
import { crumbsFor } from "@/lib/nav";

/** The way back from a sub-page. A parent page renders nothing, so the trail
 *  never repeats the heading below it (KEHOACH 9.15).
 */
export function Breadcrumb() {
  const t = useTranslations("nav");
  const here = usePathname();
  const { role, employeeId } = useSession();
  const crumbs = crumbsFor(role, employeeId !== null, here);

  if (crumbs.length === 0) {
    return null;
  }

  return (
    <nav aria-label={t("breadcrumb")} className="mb-3">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-(--color-muted)">
        {crumbs.map((crumb) => (
          <li key={crumb.key} className="flex items-center gap-1">
            {crumb.href ? (
              <Link
                href={crumb.href}
                className="rounded px-1 hover:bg-(--color-ground) hover:text-(--color-ink)"
              >
                {t(crumb.key)}
              </Link>
            ) : (
              <span className="px-1">{t(crumb.key)}</span>
            )}
            <ChevronRight className="size-3.5 shrink-0" aria-hidden />
          </li>
        ))}
      </ol>
    </nav>
  );
}
