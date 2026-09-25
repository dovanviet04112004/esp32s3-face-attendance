"use client";

import { Tabs } from "@cloudflare/kumo";
import { useTranslations } from "next-intl";

import { Link, usePathname } from "@/i18n/navigation";
import { useSession } from "@/lib/auth";
import { siblingsOf } from "@/lib/nav";

/** The sibling pages of one sidebar entry, as Cloudflare joins its section tabs (KEHOACH 9.15). */
export function SectionBar() {
  const t = useTranslations("nav");
  const here = usePathname();
  const { role, employeeId } = useSession();
  const siblings = siblingsOf(role, employeeId !== null, here);

  if (siblings.length === 0) {
    return null;
  }

  return (
    <nav
      aria-label={t("sections")}
      className="flex h-[58px] items-center overflow-x-auto border-b border-kumo-line bg-kumo-canvas px-4"
    >
      <Tabs
        variant="segmented"
        value={here}
        tabs={siblings.map((item) => ({
          value: item.href,
          label: t(item.key),
          nativeButton: false,
          render: (props) => <Link {...props} href={item.href} />,
        }))}
      />
    </nav>
  );
}
