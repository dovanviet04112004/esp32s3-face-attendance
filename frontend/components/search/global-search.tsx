"use client";

import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Network, Receipt, Search, User, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

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

const FACE: Record<HitKind, LucideIcon> = {
  employee: User,
  department: Network,
  request: CalendarDays,
  payslip: Receipt,
};

const KIND_KEY: Record<HitKind, "kindEmployee" | "kindDepartment" | "kindRequest" | "kindPayslip"> =
  {
    employee: "kindEmployee",
    department: "kindDepartment",
    request: "kindRequest",
    payslip: "kindPayslip",
  };

const kDebounceMs = 200;
const kMinLength = 2;

export function GlobalSearch() {
  const t = useTranslations("search");
  const router = useRouter();
  const box = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);

  // One request per pause in typing, not one per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setTerm(typed), kDebounceMs);
    return () => clearTimeout(timer);
  }, [typed]);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
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

  return (
    <div className="relative min-w-0 flex-1">
      <Search
        className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-(--color-muted)"
        aria-hidden
      />
      <Input
        ref={box}
        type="search"
        aria-label={t("label")}
        placeholder={t("placeholder")}
        value={typed}
        onChange={(event) => {
          setTyped(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="ps-9"
      />

      {open && term.trim().length >= kMinLength ? (
        <div className="absolute inset-x-0 top-full z-40 mt-1 max-h-80 overflow-y-auto rounded-xl border border-(--color-line) bg-(--color-surface) p-1 shadow-lg">
          {hits.isPending ? (
            <p className="px-3 py-2 text-sm text-(--color-muted)">{t("looking")}</p>
          ) : rows.length === 0 ? (
            <p className="px-3 py-2 text-sm text-(--color-muted)">{t("nothing")}</p>
          ) : (
            rows.map((hit) => {
              const Icon = FACE[hit.kind];
              return (
                <button
                  key={`${hit.kind}:${hit.id}`}
                  type="button"
                  onMouseDown={() => go(hit)}
                  className={cn(
                    "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-start text-sm",
                    "hover:bg-(--color-ground)",
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
