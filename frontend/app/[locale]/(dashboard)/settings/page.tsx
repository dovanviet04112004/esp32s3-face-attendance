"use client";

import { useMutation } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { NoticePreferences } from "@/components/notifications/notice-prefs";
import { PushSwitch } from "@/components/notifications/push-switch";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/input";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing, type Locale } from "@/i18n/routing";
import { api } from "@/lib/api";
import { useSession, type Role } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { useFault } from "@/lib/fault";

const SHORTEST = 12;

interface OpenedAccount {
  employeeCode: string;
  email: string;
  role: Role;
}

export default function SettingsPage() {
  const t = useTranslations("settings");
  const roleName = useTranslations("roles");
  const common = useTranslations("common");
  const notices = useTranslations("notices");
  const nav = useTranslations("nav");
  const locale = useLocale();
  const here = usePathname();
  const router = useRouter();
  const role = useSession((s) => s.role);
  const clear = useSession((s) => s.clear);
  const faultOf = useFault();
  const [moving, startMoving] = useTransition();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [changed, setChanged] = useState(false);
  const [passwordFault, setPasswordFault] = useState<string | null>(null);

  // Every device signs out, this one with them, so the reader lands on the
  // login page holding the password they have just chosen (KEHOACH 9.23).
  const change = useMutation({
    mutationFn: () => api.post("/auth/change-password", { current, next }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setChanged(true);
      setPasswordFault(null);
    },
    onError: (fell: unknown) => setPasswordFault(faultOf(fell)),
  });

  // The cookie dies at the server, the store here, and the page goes to the
  // form: a half-done sign-out leaves somebody looking signed in.
  const leaving = useMutation({
    mutationFn: async () => {
      await api.post("/auth/logout").catch(() => undefined);
    },
    onSuccess: () => {
      clear();
      router.replace("/login");
    },
  });

  const provision = useMutation({
    mutationFn: async () =>
      (await api.post<{ accounts: OpenedAccount[]; waiting: number }>("/users/provision")).data,
  });

  function choose(next: Locale) {
    if (next === locale) {
      return;
    }
    // Same page, other language: the locale rides on the URL, so this is a move.
    startMoving(() => router.replace(here, { locale: next }));
  }

  return (
    <section className="mx-auto w-full max-w-(--width-read)">
      <h1 className="text-lg font-semibold">{t("title")}</h1>

      <div className="mt-6 rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
        <h2 className="text-sm font-medium">{t("languageTitle")}</h2>
        <p className="mt-1 text-sm text-(--color-muted)">{t("languageLead")}</p>
        <div className="mt-4 inline-flex rounded-lg border border-(--color-line) p-1" role="group">
          {routing.locales.map((code) => (
            <button
              key={code}
              type="button"
              lang={code}
              aria-current={code === locale}
              disabled={moving}
              onClick={() => choose(code)}
              className={cn(
                "rounded-md px-4 py-1.5 text-sm disabled:opacity-60 pointer-coarse:min-h-11",
                code === locale
                  ? "bg-(--color-accent) text-(--color-on-fill)"
                  : "text-(--color-muted) hover:bg-(--color-ground)",
              )}
            >
              {t(code)}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
        <h2 className="text-sm font-medium">{t("themeTitle")}</h2>
        <p className="mt-1 text-sm text-(--color-muted)">{t("themeLead")}</p>
        <div className="mt-4">
          <ThemeToggle />
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
        <h2 className="text-sm font-medium">{notices("pushTitle")}</h2>
        <p className="mt-1 text-sm text-(--color-muted)">{notices("pushLead")}</p>
        <div className="mt-4">
          <PushSwitch />
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
        <h2 className="text-sm font-medium">{notices("prefsTitle")}</h2>
        <p className="mt-1 text-sm text-(--color-muted)">{notices("prefsLead")}</p>
        <div className="mt-4">
          <NoticePreferences />
        </div>
      </div>

      {role === "ADMIN" ? (
        <div className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
          <h2 className="text-sm font-medium">{t("provisionTitle")}</h2>
          <p className="mt-1 text-sm text-(--color-muted)">{t("provisionLead")}</p>
          <Button
            type="button"
            className="mt-4"
            disabled={provision.isPending}
            onClick={() => provision.mutate()}
          >
            {provision.isPending ? t("provisionRunning") : t("provisionRun")}
          </Button>

          {provision.isError ? (
            <p role="alert" className="mt-3 text-sm text-(--color-danger)">
              {faultOf(provision.error)}
            </p>
          ) : null}

          {provision.data?.accounts.length === 0 ? (
            <p className="mt-3 text-sm text-(--color-muted)">{t("provisionNone")}</p>
          ) : null}

          {provision.data?.accounts.length ? (
            <div className="mt-3">
              <p className="text-sm text-(--color-warn)">{t("provisionOnce")}</p>
              {provision.data.waiting > 0 ? (
                <p className="mt-1 text-sm text-(--color-muted)">
                  {t("provisionWaiting", { count: provision.data.waiting })}
                </p>
              ) : null}
              <ul className="mt-2 flex flex-col gap-1 font-mono text-xs">
                {provision.data.accounts.map((one) => (
                  <li key={one.email} className="flex flex-wrap gap-x-3">
                    <span className="min-w-24">{one.employeeCode}</span>
                    <span className="min-w-48 flex-1 truncate">{one.email}</span>
                    <span className="text-(--color-muted)">{roleName(one.role)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
        <h2 className="text-sm font-medium">{t("accountTitle")}</h2>
        <p className="mt-2 text-sm text-(--color-muted)">
          {t("role")}: <span className="font-mono text-(--color-ink)">{role ?? "—"}</span>
        </p>
        <form
          className="mt-4 border-t border-(--color-line) pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            setChanged(false);
            change.mutate();
          }}
        >
          <h3 className="text-sm font-medium">{t("passwordTitle")}</h3>
          <p className="mt-1 text-sm text-(--color-muted)">{t("passwordLead")}</p>

          <label className="mt-3 block text-sm font-medium" htmlFor="current">
            {t("passwordCurrent")}
          </label>
          <PasswordInput
            id="current"
            autoComplete="current-password"
            required
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            showLabel={common("showPassword")}
            hideLabel={common("hidePassword")}
            className="mt-1"
          />

          <label className="mt-3 block text-sm font-medium" htmlFor="next">
            {t("passwordNext")}
          </label>
          <PasswordInput
            id="next"
            autoComplete="new-password"
            required
            minLength={SHORTEST}
            value={next}
            onChange={(event) => setNext(event.target.value)}
            showLabel={common("showPassword")}
            hideLabel={common("hidePassword")}
            className="mt-1"
          />
          <p className="mt-1 text-xs text-(--color-muted)">{t("passwordHint", { count: SHORTEST })}</p>

          {changed ? (
            <p role="status" className="mt-3 text-sm text-(--color-ok)">
              {t("passwordChanged")}
            </p>
          ) : null}
          {passwordFault ? (
            <p role="alert" className="mt-3 text-sm text-(--color-danger)">
              {passwordFault}
            </p>
          ) : null}

          <Button type="submit" className="mt-3" disabled={change.isPending}>
            {change.isPending ? common("saving") : t("passwordSubmit")}
          </Button>
        </form>

        <Button
          type="button"
          tone="quiet"
          className="mt-4"
          disabled={leaving.isPending}
          onClick={() => leaving.mutate()}
        >
          {leaving.isPending ? nav("signingOut") : nav("signOut")}
        </Button>
      </div>
    </section>
  );
}
