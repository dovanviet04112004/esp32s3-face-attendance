"use client";

import { MailCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";

export default function ForgotPasswordPage() {
  const t = useTranslations("forgot");
  const app = useTranslations("app");
  const [email, setEmail] = useState("");
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await api.post("/auth/forgot-password", { email });
    } catch {
      // The answer is the same either way, so a refusal says nothing a
      // reader could act on and nothing this page should repeat.
    } finally {
      setBusy(false);
      setAsked(true);
    }
  }

  if (asked) {
    return (
      <main className="grid min-h-screen place-items-center px-4">
        <div className="w-full max-w-sm rounded-2xl border border-(--color-line) bg-(--color-surface) p-8 text-center">
          <MailCheck className="mx-auto size-8 text-(--color-ok)" aria-hidden />
          <h1 className="mt-3 text-xl font-semibold">{t("sentTitle")}</h1>
          <p className="mt-1 text-sm text-(--color-muted)">{t("sentHint")}</p>
          <Link href="/login" className="mt-6 block">
            <Button tone="quiet" className="w-full">
              {t("toLogin")}
            </Button>
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-(--color-line) bg-(--color-surface) p-8"
      >
        <h1 className="text-xl font-semibold">{app("name")}</h1>
        <p className="mt-1 text-sm text-(--color-muted)">{t("lead")}</p>

        <label className="mt-6 block text-sm font-medium" htmlFor="email">
          {t("email")}
        </label>
        <Input
          id="email"
          type="email"
          autoComplete="username"
          autoFocus
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-1"
        />

        <Button type="submit" disabled={busy} className="mt-6 w-full">
          {busy ? t("asking") : t("submit")}
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
