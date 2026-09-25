"use client";

import { CheckCircleIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/input";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";

const SHORTEST = 12;

function SetPasswordForm() {
  const t = useTranslations("setPassword");
  const app = useTranslations("app");
  const common = useTranslations("common");
  const faultOf = useFault();
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const mismatch = again !== "" && password !== again;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setRefused(null);
    if (password !== again) {
      setRefused(t("mismatch"));
      return;
    }
    setBusy(true);
    try {
      await api.post("/auth/set-password", { token, password });
      setDone(true);
    } catch (fell: unknown) {
      setRefused(faultOf(fell));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <main className="grid min-h-screen place-items-center px-4">
        <title>{app("name")}</title>
        <div className="w-full max-w-sm rounded-2xl border border-(--color-line) bg-(--color-surface) p-8 text-center">
          <CheckCircleIcon className="mx-auto size-8 text-(--color-ok)" aria-hidden />
          <h1 className="mt-3 text-xl font-semibold">{t("done")}</h1>
          <p className="mt-1 text-sm text-(--color-muted)">{t("doneHint")}</p>
          <Link href="/login" className="mt-6 block">
            <Button className="w-full">{t("toLogin")}</Button>
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <title>{app("name")}</title>
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-(--color-line) bg-(--color-surface) p-8"
      >
        <h1 className="text-xl font-semibold">{app("name")}</h1>
        <p className="mt-1 text-sm text-(--color-muted)">{t("lead")}</p>

        {token ? null : (
          <p role="alert" className="mt-4 text-sm text-(--color-danger)">
            {t("noToken")}
          </p>
        )}

        <label className="mt-6 block text-sm font-medium" htmlFor="password">
          {t("password")}
        </label>
        <PasswordInput
          id="password"
          autoComplete="new-password"
          required
          minLength={SHORTEST}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          showLabel={common("showPassword")}
          hideLabel={common("hidePassword")}
          className="mt-1"
        />
        <p className="mt-1 text-xs text-(--color-muted)">{t("hint", { count: SHORTEST })}</p>

        <label className="mt-4 block text-sm font-medium" htmlFor="again">
          {t("again")}
        </label>
        <PasswordInput
          id="again"
          autoComplete="new-password"
          required
          minLength={SHORTEST}
          aria-invalid={mismatch}
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          showLabel={common("showPassword")}
          hideLabel={common("hidePassword")}
          className="mt-1"
        />
        {mismatch ? (
          <p className="mt-1 text-xs text-(--color-danger)">{t("mismatch")}</p>
        ) : null}

        {refused ? (
          <p role="alert" className="mt-4 text-sm text-(--color-danger)">
            {refused}
          </p>
        ) : null}

        <Button type="submit" disabled={busy || !token || mismatch} className="mt-6 w-full">
          {busy ? t("saving") : t("submit")}
        </Button>

        <p className="mt-4 text-center text-sm text-(--color-muted)">
          <Link href="/login" className="underline">
            {t("toLogin")}
          </Link>
        </p>
      </form>
    </main>
  );
}

// The token arrives in the query string, which the prerender does not have.
export default function SetPasswordPage() {
  return (
    <Suspense>
      <SetPasswordForm />
    </Suspense>
  );
}
