"use client";

import { LayerCard, Tabs, type TabsItem } from "@cloudflare/kumo";
import { CaretLeftIcon } from "@phosphor-icons/react";
import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { useCrumb } from "@/components/nav/breadcrumb";
import { Link, usePathname } from "@/i18n/navigation";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { namesItself, trailFor } from "@/lib/nav";

interface HeaderProps {
  title: string;
  description?: ReactNode;
  /** Beside the title: a state pill or a count. */
  meta?: ReactNode;
  /** The primary action last, at most one secondary action beside it (KEHOACH 9.12). */
  actions?: ReactNode;
  tabs?: TabsItem[];
  tab?: string;
  onTab?: (value: string) => void;
}

/** Kumo's PageHeader block, with the trail moved up into the top bar (KEHOACH 9.15). */
export function PageHeader({ title, description, meta, actions, tabs, tab, onTab }: HeaderProps) {
  const t = useTranslations("nav");
  const here = usePathname();
  const { role, employeeId } = useSession();
  useCrumb(namesItself(here) ? title : undefined);
  const trail = trailFor(role, employeeId !== null, here);
  // The phone hides the trail for the search box, so a sub-page keeps its way up here.
  const up = namesItself(here) ? trail.at(-1) : undefined;

  return (
    <header className={cn("flex flex-col gap-2", tabs ? "mb-6" : "mb-6 xl:mb-8")}>
      {up ? (
        <Link
          href={up.href}
          className="-ms-1 flex w-fit items-center gap-1 rounded-md px-1 text-base text-kumo-subtle hover:text-kumo-default md:hidden"
        >
          <CaretLeftIcon size={14} aria-hidden />
          {t("backTo", { page: t(up.key) })}
        </Link>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="m-0 text-2xl font-semibold text-kumo-default sm:text-3xl">{title}</h1>
            {meta}
          </div>
          {description ? (
            <p className="max-w-prose text-lg leading-normal text-pretty text-kumo-subtle">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {tabs ? (
        <div className="mt-2 overflow-x-auto border-b border-kumo-line">
          <Tabs variant="underline" tabs={tabs} value={tab} onValueChange={onTab} />
        </div>
      ) : null}
    </header>
  );
}

interface LayoutProps {
  children: ReactNode;
  /** Summary the list is read with: above the main column below xl. */
  aside?: ReactNode;
  /** Tools and things to know: at the end of the page below xl. */
  extra?: ReactNode;
}

/** Kumo's ResourceListPage body: the main column and Cloudflare's right column (KEHOACH 9.12). */
export function PageLayout({ children, aside, extra }: LayoutProps) {
  if (!aside && !extra) {
    return <div className="min-w-0">{children}</div>;
  }
  // A phone reads the list first; from md the summary leads, as in Kumo's block.
  return (
    <>
      <div className="flex flex-col gap-6 md:flex-col-reverse xl:flex-row xl:gap-8">
        <div className="min-w-0 grow">{children}</div>
        <div className="top-22 flex h-fit w-full shrink-0 flex-col gap-4 xl:sticky xl:w-[380px]">
          {aside}
          {extra ? <div className="hidden flex-col gap-4 xl:flex">{extra}</div> : null}
        </div>
      </div>
      {extra ? <div className="mt-6 flex flex-col gap-4 xl:hidden">{extra}</div> : null}
    </>
  );
}

/** One card of the right column: a quiet heading strip over a lifted body. */
export function AsideCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <LayerCard>
      <LayerCard.Secondary className="justify-between">
        <span>{title}</span>
        {action}
      </LayerCard.Secondary>
      <LayerCard.Primary>{children}</LayerCard.Primary>
    </LayerCard>
  );
}

/** Label and value rows, the value right-aligned; a plain number is grouped for the locale. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  const format = useFormatter();
  return (
    <dl className="-my-1 flex flex-col">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-4 border-b border-kumo-hairline py-2 last:border-0">
          <dt className="shrink-0 text-kumo-subtle">{label}</dt>
          <dd className="min-w-0 text-end break-words">{typeof value === "number" ? format.number(value) : value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface Stat {
  key: string;
  label: string;
  value: ReactNode;
  /** Filters the list on this page. */
  onPick?: () => void;
  /** Or opens where this is handled. */
  href?: string;
  active?: boolean;
  tone?: "warning" | "danger";
}

const STAT_ROW = "flex min-h-9 w-full items-center justify-between gap-3 rounded-md px-2 text-start";
const TONE_TEXT = { warning: "text-kumo-warning", danger: "text-kumo-danger" } as const;

/** Counts that act: each filters the list beside it or leads to its queue (KEHOACH 9.12). */
export function StatList({ stats }: { stats: Stat[] }) {
  const format = useFormatter();
  return (
    <ul className="-mx-2 -my-1 flex flex-col">
      {stats.map((stat) => {
        const body = (
          <>
            <span className="min-w-0 truncate">{stat.label}</span>
            <span className={cn("shrink-0 font-medium tabular-nums", stat.tone && TONE_TEXT[stat.tone])}>
              {typeof stat.value === "number" ? format.number(stat.value) : stat.value}
            </span>
          </>
        );
        const lit = cn(STAT_ROW, "hover:bg-kumo-tint", stat.active && "bg-kumo-tint font-medium");
        return (
          <li key={stat.key}>
            {stat.href ? (
              <Link href={stat.href} className={lit}>
                {body}
              </Link>
            ) : stat.onPick ? (
              <button type="button" onClick={stat.onPick} aria-pressed={stat.active} className={lit}>
                {body}
              </button>
            ) : (
              <div className={STAT_ROW}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
