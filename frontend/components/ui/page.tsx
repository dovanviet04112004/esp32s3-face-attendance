"use client";

import { LayerCard, Tabs, type TabsItem } from "@cloudflare/kumo";
import { CaretLeftIcon } from "@phosphor-icons/react";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

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

const PHONE = "(max-width: 47.99rem)";

/** Below the width where the page frame turns into the phone layout (KEHOACH 9.21). */
export function usePhone(): boolean {
  const listen = useCallback((again: () => void) => {
    const query = window.matchMedia(PHONE);
    query.addEventListener("change", again);
    return () => query.removeEventListener("change", again);
  }, []);
  return useSyncExternalStore(
    listen,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

function ThumbActions({ children }: { children: ReactNode }) {
  const [main, setMain] = useState<HTMLElement | null>(null);
  useEffect(() => setMain(document.getElementById("main")), []);
  if (!main) {
    return null;
  }
  return (
    <>
      {createPortal(
        <div
          data-thumb-actions=""
          className="fixed end-4 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-30 flex flex-wrap justify-end gap-2 *:shadow-lg"
        >
          {children}
        </div>,
        document.body,
      )}
      {createPortal(<div aria-hidden className="h-14" />, main)}
    </>
  );
}

/** Kumo's PageHeader block, with the trail moved up into the top bar (KEHOACH 9.15).
 *  On a phone the actions leave the header for the thumb, above the tab bar (KEHOACH 9.21.2).
 */
export function PageHeader({ title, description, meta, actions, tabs, tab, onTab }: HeaderProps) {
  const t = useTranslations("nav");
  const here = usePathname();
  const phone = usePhone();
  const { role, employeeId } = useSession();
  useCrumb(namesItself(here) ? title : undefined);
  const trail = trailFor(role, employeeId !== null, here);
  // The phone hides the trail for the search box, so a sub-page keeps its way up here.
  const up = namesItself(here) ? trail.at(-1) : undefined;

  return (
    <header className={cn("flex flex-col gap-2", tabs ? "mb-4 sm:mb-6" : "mb-4 sm:mb-6 xl:mb-8")}>
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
            <p className="hidden max-w-prose text-lg leading-normal text-pretty text-kumo-subtle md:block">{description}</p>
          ) : null}
        </div>
        {actions && !phone ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        {actions && phone ? <ThumbActions>{actions}</ThumbActions> : null}
      </div>
      {tabs ? <TabStrip tabs={tabs} tab={tab} onTab={onTab} /> : null}
    </header>
  );
}

/** Underline tabs that scroll sideways when they outgrow the page, fading the edge that hides more. */
function TabStrip({ tabs, tab, onTab }: { tabs: TabsItem[]; tab?: string; onTab?: (value: string) => void }) {
  const strip = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    const held = strip.current;
    if (!held) {
      return;
    }
    const check = () => setMore(held.scrollLeft + held.clientWidth < held.scrollWidth - 1);
    check();
    const watch = new ResizeObserver(check);
    watch.observe(held);
    held.addEventListener("scroll", check, { passive: true });
    return () => {
      watch.disconnect();
      held.removeEventListener("scroll", check);
    };
  }, [tabs]);

  return (
    <div
      ref={strip}
      className={cn(
        "mt-2 overflow-x-auto border-b border-kumo-line [scrollbar-width:none]",
        more && "[mask-image:linear-gradient(to_right,black_calc(100%-48px),transparent)]",
      )}
    >
      <Tabs variant="underline" tabs={tabs} value={tab} onValueChange={onTab} />
    </div>
  );
}

interface LayoutProps {
  children: ReactNode;
  /** What the list is read with: pending work, totals of the filtered set. */
  aside?: ReactNode;
  /** Tools and things to know, under the aside. */
  extra?: ReactNode;
}

/** How far the main column's opening toolbar pushes its first card down, so the right column
 *  can start level with that card rather than with a row of buttons (KEHOACH 9.12).
 */
function useToolbarLead(main: HTMLDivElement | null): number {
  const [lead, setLead] = useState(0);
  useEffect(() => {
    const first = main?.firstElementChild;
    if (!(first instanceof HTMLElement) || !first.hasAttribute("data-toolbar")) {
      setLead(0);
      return;
    }
    const measure = () => setLead(first.offsetHeight + parseFloat(getComputedStyle(first).marginBottom));
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(first);
    return () => watch.disconnect();
  }, [main]);
  return lead;
}

/** Kumo's ResourceListPage body: the main column and Cloudflare's right column (KEHOACH 9.12).
 *  In a content box from 1024 px the right column is 380 px, sticky, and scrolls on its own;
 *  in a narrower one it follows the main column.
 */
export function PageLayout({ children, aside, extra }: LayoutProps) {
  const [main, setMain] = useState<HTMLDivElement | null>(null);
  const lead = useToolbarLead(main);
  if (!aside && !extra) {
    return <div className="min-w-0">{children}</div>;
  }
  // The inset keeps the cards' rings clear of the column's own scroll clip.
  return (
    <div className="@container/page">
      <div className="flex flex-col gap-6 @5xl/page:flex-row @5xl/page:gap-8">
        <div ref={setMain} className="min-w-0 grow">
          {children}
        </div>
        <div
          style={{ "--aside-lead": `${lead}px` } as CSSProperties}
          className="flex h-fit w-full shrink-0 flex-col gap-4 *:shrink-0 @5xl/page:sticky @5xl/page:top-[calc(82px+env(safe-area-inset-top))] @5xl/page:-m-1 @5xl/page:mt-[calc(var(--aside-lead)-0.25rem)] @5xl/page:max-h-[calc(100svh-106px-env(safe-area-inset-top))] @5xl/page:w-[388px] @5xl/page:overflow-y-auto @5xl/page:overscroll-contain @5xl/page:p-1"
        >
          {aside}
          {extra}
        </div>
      </div>
    </div>
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
  /** Acts on this page, such as opening the work it counts. */
  onPick?: () => void;
  /** Or opens where this is handled. */
  href?: string;
  active?: boolean;
  tone?: "warning" | "danger";
}

const STAT_ROW = "flex min-h-9 w-full items-center justify-between gap-3 rounded-md px-2 text-start";
const TONE_TEXT = { warning: "text-kumo-warning", danger: "text-kumo-danger" } as const;

/** Counts that act: totals of the filtered set, or work that leads to its queue (KEHOACH 9.12).
 *  A count per filter value belongs inside that filter's options, not here.
 */
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
