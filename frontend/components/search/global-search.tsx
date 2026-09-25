"use client";

import { useQuery } from "@tanstack/react-query";
import type { Icon as IconType } from "@phosphor-icons/react";
import {
  CalendarBlankIcon,
  MagnifyingGlassIcon,
  ReceiptIcon,
  TreeStructureIcon,
  UserIcon,
} from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";

type HitKind = "employee" | "department" | "request" | "payslip";

interface Hit {
  kind: HitKind;
  id: string;
  title: string;
  detail: string;
  href: string;
}

const FACE: Record<HitKind, IconType> = {
  employee: UserIcon,
  department: TreeStructureIcon,
  request: CalendarBlankIcon,
  payslip: ReceiptIcon,
};

const KIND_KEY: Record<HitKind, "kindEmployee" | "kindDepartment" | "kindRequest" | "kindPayslip"> =
  {
    employee: "kindEmployee",
    department: "kindDepartment",
    request: "kindRequest",
    payslip: "kindPayslip",
  };

// A slash belongs to whatever is being typed into, not to the search box.
const TYPED_IN = new Set(["INPUT", "TEXTAREA", "SELECT"]);

const kDebounceMs = 200;
const kMinLength = 2;

export function GlobalSearch() {
  const t = useTranslations("search");
  const router = useRouter();
  const box = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [typed, setTyped] = useState("");
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);

  // One request per pause in typing, not one per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setTerm(typed), kDebounceMs);
    return () => clearTimeout(timer);
  }, [typed]);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const held = document.activeElement as HTMLElement | null;
      const typing =
        held !== null &&
        (TYPED_IN.has(held.tagName) || held.isContentEditable);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        box.current?.focus();
      }
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const hits = useQuery({
    queryKey: ["search", term],
    enabled: term.trim().length >= kMinLength,
    queryFn: async () =>
      (await api.get<Hit[]>(`/search?q=${encodeURIComponent(term)}`)).data,
  });

  function go(hit: Hit): void {
    setOpen(false);
    setTyped("");
    router.push(hit.href);
  }

  const rows = hits.data ?? [];
  const showing = open && term.trim().length >= kMinLength;
  const active = rows[at];

  function walk(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (!showing || rows.length === 0) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setAt((held) => (held + 1) % rows.length);
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setAt((held) => (held - 1 + rows.length) % rows.length);
    }
    if (event.key === "Enter" && active) {
      event.preventDefault();
      go(active);
    }
  }

  return (
    <div className="relative min-w-0 flex-1">
      <MagnifyingGlassIcon
        className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-(--color-muted)"
        aria-hidden
      />
      <Input
        ref={box}
        type="search"
        aria-label={t("label")}
        placeholder={t("placeholder")}
        role="combobox"
        aria-expanded={showing}
        aria-controls={listId}
        aria-activedescendant={showing && active ? `${listId}-${at}` : undefined}
        aria-autocomplete="list"
        value={typed}
        onChange={(event) => {
          setTyped(event.target.value);
          setAt(0);
          setOpen(true);
        }}
        onKeyDown={walk}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="ps-9"
      />

      {showing ? (
        <div
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-full z-40 mt-1 max-h-80 overflow-y-auto rounded-xl border border-(--color-line) bg-(--color-surface) p-1 shadow-lg"
        >
          {hits.isPending ? (
            <p className="px-3 py-2 text-sm text-(--color-muted)">{t("looking")}</p>
          ) : rows.length === 0 ? (
            <p className="px-3 py-2 text-sm text-(--color-muted)">{t("nothing")}</p>
          ) : (
            rows.map((hit, index) => {
              const Icon = FACE[hit.kind];
              return (
                <button
                  key={`${hit.kind}:${hit.id}`}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === at}
                  type="button"
                  onPointerDown={() => go(hit)}
                  onMouseEnter={() => setAt(index)}
                  className={cn(
                    "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-start text-sm",
                    index === at ? "bg-(--color-ground)" : "",
                  )}
                >
                  <Icon className="size-4 shrink-0 text-(--color-muted)" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{hit.title}</span>
                    <span className="block truncate text-xs text-(--color-muted)">
                      {hit.detail}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] text-(--color-muted)">
                    {t(KIND_KEY[hit.kind])}
                  </span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
