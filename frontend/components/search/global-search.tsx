"use client";

import { Button, CommandPalette } from "@cloudflare/kumo";
import type { Icon as IconType } from "@phosphor-icons/react";
import {
  ArrowRightIcon,
  CalendarBlankIcon,
  MagnifyingGlassIcon,
  ReceiptIcon,
  TreeStructureIcon,
  UserIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

import type { RequestKind } from "@/components/requests/request-card";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { entriesFor } from "@/lib/nav";

type HitKind = "employee" | "department" | "request" | "payslip";

interface Hit {
  kind: HitKind;
  id: string;
  title: string;
  detail: string;
  href: string;
  requestKind?: RequestKind;
}

interface Found {
  id: string;
  title: string;
  detail: string | null;
  href: string;
  icon: IconType;
}

interface Pile {
  id: string;
  label: string;
  items: Found[];
}

const FACE: Record<HitKind, IconType> = {
  employee: UserIcon,
  department: TreeStructureIcon,
  request: CalendarBlankIcon,
  payslip: ReceiptIcon,
};

const KIND_KEY = {
  employee: "kindEmployee",
  department: "kindDepartment",
  request: "kindRequest",
  payslip: "kindPayslip",
} as const;

const KINDS: HitKind[] = ["employee", "department", "request", "payslip"];

// A slash belongs to whatever is being typed into, not to the search box.
const TYPED_IN = new Set(["INPUT", "TEXTAREA", "SELECT"]);

const kDebounceMs = 200;
const kMinLength = 2;
// The api refuses a longer term (SearchQueryDto).
const kMaxLength = 64;

function folded(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Cloudflare's quick search: pages this role can open, then people,
 *  departments, requests and payslips from the api (KEHOACH 9.20).
 */
/** The field-shaped button the top bar shows; with no `onOpen` it is the inert copy of the opening frame. */
export function SearchTrigger({ onOpen }: { onOpen?: () => void }) {
  const t = useTranslations("search");
  return (
    <Button
      variant="secondary"
      icon={MagnifyingGlassIcon}
      onClick={onOpen}
      className="w-full justify-start font-normal text-kumo-subtle"
    >
      <span className="min-w-0 flex-1 truncate text-start">{t("placeholder")}</span>
      <kbd className="hidden rounded border border-kumo-hairline bg-kumo-base px-1.5 text-xs md:inline">/</kbd>
    </Button>
  );
}

export function GlobalSearch() {
  const t = useTranslations("search");
  const nav = useTranslations("nav");
  const requests = useTranslations("requests");
  const router = useRouter();
  const { role, employeeId } = useSession();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [term, setTerm] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setTerm(typed.trim().slice(0, kMaxLength)), kDebounceMs);
    return () => clearTimeout(timer);
  }, [typed]);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const held = document.activeElement as HTMLElement | null;
      const typing = held !== null && (TYPED_IN.has(held.tagName) || held.isContentEditable);
      const chord = event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey);
      if (chord || (event.key === "/" && !typing)) {
        event.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const hits = useQuery({
    queryKey: ["search", term],
    enabled: open && term.length >= kMinLength,
    queryFn: async () => (await api.get<Hit[]>(`/search?q=${encodeURIComponent(term)}`)).data,
  });

  const piles = useMemo<Pile[]>(() => {
    const needle = folded(typed.trim());
    const pages = entriesFor(role, employeeId !== null)
      .flatMap((group) => group.entries.flatMap((entry) => entry.members))
      .filter((item) => needle === "" || folded(nav(item.key)).includes(needle))
      .map((item) => ({
        id: `page:${item.href}`,
        title: nav(item.key),
        detail: null,
        href: item.href,
        icon: item.icon,
      }));
    const found = term.length >= kMinLength ? (hits.data ?? []) : [];
    return [
      { id: "pages", label: t("pages"), items: pages },
      ...KINDS.map((kind) => ({
        id: kind,
        label: t(KIND_KEY[kind]),
        items: found
          .filter((hit) => hit.kind === kind)
          .map((hit) => ({
            id: `${kind}:${hit.id}`,
            title: hit.title,
            detail: hit.requestKind ? `${requests(`kind${hit.requestKind}`)} · ${hit.detail}` : hit.detail,
            href: hit.href,
            icon: FACE[kind],
          })),
      })),
    ].filter((pile) => pile.items.length > 0);
  }, [typed, term, hits.data, role, employeeId, nav, t, requests]);

  function go(item: Found): void {
    setOpen(false);
    setTyped("");
    router.push(item.href);
  }

  return (
    <>
      <SearchTrigger onOpen={() => setOpen(true)} />

      <CommandPalette.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setTyped("");
          }
        }}
        items={piles}
        value={typed}
        onValueChange={setTyped}
        itemToStringValue={(pile) => pile.label}
        filter={() => true}
        getSelectableItems={(all) => all.flatMap((pile) => pile.items)}
        onSelect={(item) => go(item)}
      >
        <CommandPalette.Input placeholder={t("placeholder")} autoComplete="off" spellCheck={false} />
        <CommandPalette.List>
          {term.length >= kMinLength && hits.isFetching && piles.length === 0 ? (
            <CommandPalette.Loading />
          ) : (
            <>
              <CommandPalette.Results>
                {(pile: Pile) => (
                  <CommandPalette.Group key={pile.id} items={pile.items}>
                    <CommandPalette.GroupLabel>{pile.label}</CommandPalette.GroupLabel>
                    <CommandPalette.Items>
                      {(item: Found) => {
                        const Icon = item.icon;
                        return (
                          <CommandPalette.Item key={item.id} value={item} onClick={() => go(item)}>
                            <span className="flex min-w-0 items-center gap-3">
                              <Icon size={16} className="shrink-0 text-kumo-subtle" aria-hidden />
                              <span className="min-w-0">
                                <span className="block truncate">{item.title}</span>
                                {item.detail ? (
                                  <span className="block truncate text-sm text-kumo-subtle">{item.detail}</span>
                                ) : null}
                              </span>
                              {item.detail === null ? (
                                <ArrowRightIcon size={14} className="ms-auto shrink-0 text-kumo-subtle" aria-hidden />
                              ) : null}
                            </span>
                          </CommandPalette.Item>
                        );
                      }}
                    </CommandPalette.Items>
                  </CommandPalette.Group>
                )}
              </CommandPalette.Results>
              <CommandPalette.Empty>{t("nothing")}</CommandPalette.Empty>
            </>
          )}
        </CommandPalette.List>
        <CommandPalette.Footer>
          <span className="flex items-center gap-2">
            <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5 text-xs">↑↓</kbd>
            <span>{t("walk")}</span>
          </span>
          <span className="flex items-center gap-2">
            <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5 text-xs">↵</kbd>
            <span>{t("open")}</span>
          </span>
        </CommandPalette.Footer>
      </CommandPalette.Root>
    </>
  );
}
