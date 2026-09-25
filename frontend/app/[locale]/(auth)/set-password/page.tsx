"use client";

import { Banner, Button, LayerCard, Link, LinkButton } from "@cloudflare/kumo";
import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";

import { PasswordField } from "@/components/ui/password-field";
import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";

const SHORTEST = 12;

function SetPasswordForm() {
  const t = useTranslations("setPassword");
  const faultOf = useFault();
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [shown, setShown] = useState(false);
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
      <LayerCard>
        <LayerCard.Primary className="p-6 sm:p-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <CheckCircleIcon size={40} weight="fill" className="text-kumo-success" aria-hidden />
            <h1 className="m-0 text-2xl font-semibold">{t("done")}</h1>
            <p className="text-kumo-subtle">{t("doneHint")}</p>
            <LinkButton href="/login" variant="primary" className="mt-3 w-full justify-center">
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
            {token ? null : <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={t("noToken")} />}
            <PasswordField
              label={t("password")}
              description={t("hint", { count: SHORTEST })}
              shown={shown}
              onShownChange={setShown}
              autoComplete="new-password"
              required
              minLength={SHORTEST}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <PasswordField
              label={t("again")}
              error={mismatch ? t("mismatch") : undefined}
              shown={shown}
              toggle={false}
              autoComplete="new-password"
              required
              minLength={SHORTEST}
              aria-invalid={mismatch}
              value={again}
              onChange={(event) => setAgain(event.target.value)}
            />
            {refused ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={refused} /> : null}
            <Button type="submit" variant="primary" loading={busy} disabled={!token || mismatch} className="w-full justify-center">
              {t("submit")}
            </Button>
          </form>
        </LayerCard.Primary>
      </LayerCard>
      <p className="text-center"><Link href="/login">{t("toLogin")}</Link></p>
    </>
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
