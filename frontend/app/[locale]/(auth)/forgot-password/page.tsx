"use client";

import { Button, Input, Link, LinkButton } from "@cloudflare/kumo";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { api } from "@/lib/api";

export default function ForgotPasswordPage() {
  const t = useTranslations("forgot");
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
      <div className="flex flex-col gap-6">
        <EnvelopeSimpleIcon size={40} weight="fill" className="text-kumo-success" aria-hidden />
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-3xl font-semibold text-kumo-default">{t("sentTitle")}</h1>
          <p className="text-lg text-pretty text-kumo-subtle">{t("sentHint")}</p>
        </div>
        <LinkButton href="/login" variant="secondary" size="lg" className="w-full justify-center">
          {t("toLogin")}
        </LinkButton>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="m-0 text-3xl font-semibold text-kumo-default">{t("title")}</h1>
        <p className="text-lg text-pretty text-kumo-subtle">{t("lead")}</p>
      </div>
      <Input
        size="lg"
        label={t("email")}
        type="email"
        autoComplete="username"
        autoFocus
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full justify-center">
        {t("submit")}
      </Button>
      <p className="text-base">
        <Link href="/login">{t("toLogin")}</Link>
      </p>
    </form>
  );
}
