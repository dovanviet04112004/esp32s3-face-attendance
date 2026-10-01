"use client";

import { Button, CommandPalette } from "@cloudflare/kumo";
import type { Icon as IconType } from "@phosphor-icons/react";
import {
  ArrowRightIcon,
  CalendarBlankIcon,
  CertificateIcon,
  ChatCircleTextIcon,
  CpuIcon,
  FilesIcon,
  HandCoinsIcon,
  IdentificationCardIcon,
  MagnifyingGlassIcon,
  PackageIcon,
  ReceiptIcon,
  TreeStructureIcon,
  UserIcon,
  UsersThreeIcon,
  WalletIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { RequestKind } from "@/components/requests/request-card";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { entriesFor } from "@/lib/nav";

const KINDS = [
  "employee",
  "department",
  "request",
  "certificate",
  "profileChange",
  "dispute",
  "dependent",
  "advance",
  "payslip",
  "payrollPeriod",
  "kiosk",
  "asset",
  "document",
] as const;

type HitKind = (typeof KINDS)[number];

interface Hit {
  kind: HitKind;
  id: string;
  title: string;
  detail: string;
  href: string;
  requestKind?: RequestKind;
  certificateKind?: "EMPLOYMENT" | "INCOME";
  profileField?: "PERSONAL_EMAIL" | "PHONE" | "BANK" | "NATIONAL_ID" | "TAX_CODE" | "SOCIAL_INSURANCE_NO";
  documentKind?: "POLICY" | "HANDBOOK" | "NOTICE";
}

interface Reply {
  hits: Hit[];
  more: { kind: HitKind; href: string }[];
}

interface Found {
  id: string;
  title: string;
  detail: string | null;
  href: string;
  icon: IconType;
  more?: boolean;
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
  certificate: CertificateIcon,
  profileChange: IdentificationCardIcon,
  dispute: ChatCircleTextIcon,
  dependent: UsersThreeIcon,
  advance: HandCoinsIcon,
  payslip: ReceiptIcon,
  payrollPeriod: WalletIcon,
  kiosk: CpuIcon,
  asset: PackageIcon,
  document: FilesIcon,
};

// Literal keys, not a built string: a missing translation has to break the build (CLAUDE.md 3.1).
const KIND_KEY = {
  employee: "kindEmployee",
  department: "kindDepartment",
  request: "kindRequest",
  certificate: "kindCertificate",
  profileChange: "kindProfileChange",
  dispute: "kindDispute",
  dependent: "kindDependent",
  advance: "kindAdvance",
  payslip: "kindPayslip",
  payrollPeriod: "kindPayrollPeriod",
  kiosk: "kindKiosk",
  asset: "kindAsset",
  document: "kindDocument",
} as const;

// A slash belongs to whatever is being typed into, not to the search box.
const TYPED_IN = new Set(["INPUT", "TEXTAREA", "SELECT"]);

const kDebounceMs = 200;
const kMinLength = 2;
// The api refuses a longer term (SearchQueryDto).
const kMaxLength = 64;

// NFD leaves đ whole, since Unicode files it as a letter of its own rather than d with a mark.
function folded(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/đ/g, "d");
}

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

/** What a hit is, ahead of its codes and dates: the kind of request, letter, change or document. */
function useHitDetail(): (hit: Hit) => string {
  const requests = useTranslations("requests");
  const letters = useTranslations("certificates");
  const profile = useTranslations("profile");
  const documents = useTranslations("documents");
  const payroll = useTranslations("payroll");
  return useCallback(
    (hit: Hit) => {
      const what = hit.requestKind
        ? requests(`kind${hit.requestKind}`)
        : hit.certificateKind
          ? letters(hit.certificateKind)
          : hit.profileField
            ? profile(`field${hit.profileField}`)
            : hit.documentKind
              ? documents(`kind_${hit.documentKind}`)
              : null;
      const detail = hit.kind === "payrollPeriod" && hit.detail === "" ? payroll("wholeCompany") : hit.detail;
      return what ? `${what} · ${detail}` : detail;
    },
    [requests, letters, profile, documents, payroll],
  );
}

/** Cloudflare's quick search: pages this role can open, then every kind of KEHOACH 9.20 the api finds. */
export function GlobalSearch() {
  const t = useTranslations("search");
  const nav = useTranslations("nav");
  const detailOf = useHitDetail();
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

  const wanted = typed.trim().slice(0, kMaxLength);

  const found = useQuery({
    queryKey: ["search", term],
    enabled: open && term.length >= kMinLength,
    queryFn: async () => (await api.get<Reply>(`/search?q=${encodeURIComponent(term)}`)).data,
  });

  const loading = wanted.length >= kMinLength && (wanted !== term || found.isFetching);

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
    const reply = term.length >= kMinLength ? found.data : undefined;
    return [
      { id: "pages", label: t("pages"), items: pages },
      ...KINDS.map((kind) => {
        const more = reply?.more.find((one) => one.kind === kind);
        return {
          id: kind,
          label: t(KIND_KEY[kind]),
          items: [
            ...(reply?.hits ?? [])
              .filter((hit) => hit.kind === kind)
              .map((hit) => ({
                id: `${kind}:${hit.id}`,
                title: hit.title,
                detail: detailOf(hit),
                href: hit.href,
                icon: FACE[kind],
              })),
            ...(more
              ? [{ id: `more:${kind}`, title: t("seeAll"), detail: null, href: more.href, icon: MagnifyingGlassIcon, more: true }]
              : []),
          ],
        };
      }),
    ].filter((pile) => pile.items.length > 0);
  }, [typed, term, found.data, role, employeeId, nav, t, detailOf]);

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
        <CommandPalette.Input
          placeholder={t("placeholder")}
          autoComplete="off"
          spellCheck={false}
          // Base UI reports text only at compositionend, and a Vietnamese IME composes a word until space.
          onChange={(event) => setTyped(event.currentTarget.value)}
        />
        <CommandPalette.List>
          <CommandPalette.Results>
            {(pile: Pile) => (
              <CommandPalette.Group key={pile.id} items={pile.items}>
                <CommandPalette.GroupLabel>{pile.label}</CommandPalette.GroupLabel>
                <CommandPalette.Items>
                  {(item: Found) => {
                    const Icon = item.icon;
                    return (
                      <CommandPalette.Item key={item.id} value={item} onClick={() => go(item)}>
                        <span className="flex min-w-0 flex-1 items-center gap-3">
                          <Icon size={16} className="shrink-0 text-kumo-subtle" aria-hidden />
                          <span className="min-w-0">
                            <span className={item.more ? "block truncate text-kumo-subtle" : "block truncate"}>{item.title}</span>
                            {item.detail ? <span className="block truncate text-sm text-kumo-subtle">{item.detail}</span> : null}
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
          {loading ? <CommandPalette.Loading /> : <CommandPalette.Empty>{t("nothing")}</CommandPalette.Empty>}
        </CommandPalette.List>
        <div className="contents pointer-coarse:hidden">
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
        </div>
      </CommandPalette.Root>
    </>
  );
}
