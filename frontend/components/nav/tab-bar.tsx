"use client";

import { Badge, LayerDialog } from "@cloudflare/kumo";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { SkeletonLine } from "@/components/ui/skeleton";
import { Link, usePathname } from "@/i18n/navigation";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { entriesFor, entryOf, tabsFor, type NavEntry } from "@/lib/nav";
import { useWaitingCount } from "./waiting-count";

const kPhone = "(max-width: 47.99rem)";
const kTyped = "input:not([type=checkbox],[type=radio],[type=button],[type=submit]),textarea,[contenteditable=true]";
// The keyboard slides up and resizes the viewport over about this long on iOS and Android.
const kKeyboardMs = 320;

function isTyping(node: EventTarget | null): node is HTMLElement {
  return node instanceof HTMLElement && node.matches(kTyped);
}

/** While a phone types, the bar steps off the keyboard and the field comes to the middle
 *  of what the keyboard leaves (KEHOACH 9.21.6).
 */
function useTyping(): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const phone = window.matchMedia(kPhone);
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const focused = (event: FocusEvent) => {
      if (!phone.matches || !isTyping(event.target)) {
        return;
      }
      const field = event.target;
      setTyping(true);
      clearTimeout(timer);
      timer = setTimeout(
        () => field.scrollIntoView({ block: "center", behavior: calm.matches ? "auto" : "smooth" }),
        kKeyboardMs,
      );
    };
    const left = (event: FocusEvent) => setTyping(isTyping(event.relatedTarget) && phone.matches);
    document.addEventListener("focusin", focused);
    document.addEventListener("focusout", left);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("focusin", focused);
      document.removeEventListener("focusout", left);
    };
  }, []);
  return typing;
}

const kBar =
  "fixed inset-x-0 bottom-0 z-40 flex border-t border-kumo-line bg-kumo-canvas pb-[env(safe-area-inset-bottom)] [view-transition-name:tab-bar] md:hidden";

function tabClass(active: boolean): string {
  return cn(
    "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-xs motion-press",
    active ? "text-kumo-link" : "text-kumo-subtle",
  );
}

function Count({ waiting }: { waiting: number }) {
  return (
    <Badge variant="warning" className="pointer-events-none absolute -top-1.5 -right-3 px-1.5 tabular-nums">
      {waiting}
    </Badge>
  );
}

function Tab({ entry, active, waiting }: { entry: NavEntry; active: boolean; waiting: number }) {
  const t = useTranslations("nav");
  const Icon = entry.icon;
  return (
    <Link href={entry.href} aria-current={active ? "page" : undefined} className={tabClass(active)}>
      <span className="relative">
        <Icon className="size-5" weight={active ? "fill" : "regular"} aria-hidden />
        {entry.badge === "approvals" && waiting > 0 ? <Count waiting={waiting} /> : null}
      </span>
      <span className="max-w-full truncate">{t(entry.short)}</span>
    </Link>
  );
}

/** The bar's slots in skeleton, each icon and label on the line the real one takes. */
export function TabBarLoading({ slots }: { slots: number }) {
  if (slots === 0) {
    return null;
  }
  return (
    <nav inert className={kBar}>
      {Array.from({ length: slots }, (_, at) => (
        <span key={at} className={tabClass(false)}>
          <SkeletonLine className="size-5 rounded-md" />
          <span className="flex h-4 items-center">
            <SkeletonLine className="h-2 w-10 rounded-full" />
          </span>
        </span>
      ))}
    </nav>
  );
}

/** The phone's navigation, five slots at the thumb (KEHOACH 9.21.1). */
export function TabBar() {
  const t = useTranslations("nav");
  const here = usePathname();
  const { role, employeeId } = useSession();
  const hasRecord = employeeId !== null;
  const { items, rest } = tabsFor(role, hasRecord);
  const waiting = useWaitingCount(role);
  const [open, setOpen] = useState(false);
  const typing = useTyping();
  const current = entryOf(entriesFor(role, hasRecord), here)?.href;

  return (
    <>
      <nav
        aria-label={t("primary")}
        data-typing={typing ? "" : undefined}
        className={cn(kBar, typing && "hidden")}
      >
        {items.map((entry) => (
          <Tab key={entry.href} entry={entry} active={current === entry.href} waiting={waiting} />
        ))}
        {rest.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={open}
            className={tabClass(rest.some((group) => group.entries.some((entry) => entry.href === current)))}
          >
            <DotsThreeIcon className="size-5" aria-hidden />
            <span>{t("more")}</span>
          </button>
        ) : null}
      </nav>

      <LayerDialog.Root open={open} onOpenChange={setOpen}>
        <LayerDialog.Content closeLabel={t("close")}>
          <LayerDialog.Title>{t("more")}</LayerDialog.Title>
          <LayerDialog.Body>
            <div className="flex flex-col gap-4">
              {rest.map((group) => (
                <div key={group.key}>
                  <p className="pb-1 text-sm font-medium text-kumo-subtle">{t(group.key)}</p>
                  <div className="flex flex-col">
                    {group.entries.map((entry) => {
                      const Icon = entry.icon;
                      return (
                        <Link
                          key={entry.href}
                          href={entry.href}
                          onClick={() => setOpen(false)}
                          aria-current={current === entry.href ? "page" : undefined}
                          className="flex min-h-11 items-center gap-3 rounded-lg px-2 text-base hover:bg-kumo-tint aria-[current=page]:bg-kumo-tint"
                        >
                          <Icon className="size-4 text-kumo-subtle" aria-hidden />
                          <span className="flex-1">{t(entry.key)}</span>
                          {entry.badge === "approvals" && waiting > 0 ? (
                            <Badge variant="warning" className="tabular-nums">
                              {waiting}
                            </Badge>
                          ) : null}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog.Root>
    </>
  );
}
