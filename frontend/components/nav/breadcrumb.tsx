"use client";

import { Breadcrumbs } from "@cloudflare/kumo";
import { HouseIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { create } from "zustand";

import { usePathname } from "@/i18n/navigation";
import { useSession } from "@/lib/auth";
import { homeFor, namesItself, trailFor } from "@/lib/nav";

interface Named {
  path: string | null;
  title: string | null;
  set: (path: string, title: string) => void;
}

const useNamed = create<Named>((set) => ({
  path: null,
  title: null,
  set: (path, title) => set({ path, title }),
}));

/** A page reports what it shows, so the trail can end on a record's own name (KEHOACH 9.15). */
export function useCrumb(title: string | undefined): void {
  const here = usePathname();
  const set = useNamed((s) => s.set);
  useEffect(() => {
    if (title) {
      set(here, title);
    }
  }, [here, title, set]);
}

export function Breadcrumb() {
  const t = useTranslations("nav");
  const here = usePathname();
  const { role, employeeId } = useSession();
  const hasRecord = employeeId !== null;
  const named = useNamed();
  const trail = trailFor(role, hasRecord, here);
  const home = homeFor(role, hasRecord);
  // A title held for another path belongs to the page just left.
  const title = namesItself(here) && named.path === here ? named.title : null;
  const waiting = namesItself(here) && title === null;

  if (here === home || trail.length === 0) {
    return (
      <Breadcrumbs size="sm">
        <Breadcrumbs.Current icon={<HouseIcon size={16} />}>
          {trail[0] ? t(trail[0].key) : t("home")}
        </Breadcrumbs.Current>
      </Breadcrumbs>
    );
  }

  const last = trail.length - 1;
  // Kumo reads its items off the direct children, so the trail is one flat list.
  const items = trail.flatMap((crumb, at) => [
    <Breadcrumbs.Separator key={`sep-${at}`} />,
    at === last && !namesItself(here) ? (
      <Breadcrumbs.Current key={`crumb-${at}`}>{t(crumb.key)}</Breadcrumbs.Current>
    ) : (
      <Breadcrumbs.Link key={`crumb-${at}`} href={crumb.href}>
        {t(crumb.key)}
      </Breadcrumbs.Link>
    ),
  ]);
  if (namesItself(here)) {
    items.push(
      <Breadcrumbs.Separator key="sep-title" />,
      <Breadcrumbs.Current key="title" loading={waiting}>
        {title}
      </Breadcrumbs.Current>,
    );
  }

  return (
    <Breadcrumbs size="sm">
      <Breadcrumbs.Link href={home} icon={<HouseIcon size={16} />}>
        {t("home")}
      </Breadcrumbs.Link>
      {items}
    </Breadcrumbs>
  );
}
