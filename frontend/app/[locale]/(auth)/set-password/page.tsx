"use client";

import { Banner, Button, Link, LinkButton } from "@cloudflare/kumo";
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
      <div className="flex flex-col gap-6">
        <CheckCircleIcon size={40} weight="fill" className="text-kumo-success" aria-hidden />
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-3xl font-semibold text-kumo-default">{t("done")}</h1>
          <p className="text-lg text-pretty text-kumo-subtle">{t("doneHint")}</p>
        </div>
        <LinkButton href="/login" variant="primary" size="lg" className="w-full justify-center">
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
      {token ? null : <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={t("noToken")} />}
      <div className="flex flex-col gap-5">
        <PasswordField
          size="lg"
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
          size="lg"
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
      </div>
      {refused ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={refused} /> : null}
      <Button
        type="submit"
        variant="primary"
        size="lg"
        loading={busy}
        disabled={!token || mismatch}
        className="w-full justify-center"
      >
        {t("submit")}
      </Button>
      <p className="text-base">
        <Link href="/login">{t("toLogin")}</Link>
      </p>
    </form>
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
