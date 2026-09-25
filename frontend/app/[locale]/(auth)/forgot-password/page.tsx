"use client";

import { Button, Input, LayerCard, Link, LinkButton } from "@cloudflare/kumo";
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
      <LayerCard>
        <LayerCard.Primary className="p-6 sm:p-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <EnvelopeSimpleIcon size={40} weight="fill" className="text-kumo-success" aria-hidden />
            <h1 className="m-0 text-2xl font-semibold">{t("sentTitle")}</h1>
            <p className="text-kumo-subtle">{t("sentHint")}</p>
            <LinkButton href="/login" variant="secondary" className="mt-3 w-full justify-center">
              {t("toLogin")}
            </LinkButton>
          </div>
        </LayerCard.Primary>
      </LayerCard>
    );
  }

  return (
    <>
      <LayerCard>
        <LayerCard.Primary className="p-6 sm:p-8">
          <form onSubmit={submit} className="flex flex-col gap-5">
            <div className="flex flex-col gap-1">
              <h1 className="m-0 text-2xl font-semibold">{t("title")}</h1>
              <p className="text-kumo-subtle">{t("lead")}</p>
            </div>
            <Input
              label={t("email")}
              type="email"
              autoComplete="username"
              autoFocus
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Button type="submit" variant="primary" loading={busy} className="w-full justify-center">
              {t("submit")}
            </Button>
          </form>
        </LayerCard.Primary>
      </LayerCard>
      <p className="text-center"><Link href="/login">{t("toLogin")}</Link></p>
    </>
  );
}
