"use client";

import { Banner, Button, LinkButton } from "@cloudflare/kumo";
import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { api } from "@/lib/api";
import { useFault } from "@/lib/fault";

function NotMeForm() {
  const t = useTranslations("notMe");
  const faultOf = useFault();
  const inAddress = useSearchParams().get("token") ?? "";
  const [token] = useState(inAddress);
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // Read once, then gone from the address bar, so history and bookmarks never keep it (KEHOACH 7.2).
  useEffect(() => {
    if (inAddress) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [inAddress]);

  // Only the button acts: mail filters open every link of a letter on their own (KEHOACH 9.4).
  async function press() {
    setBusy(true);
    setRefused(null);
    try {
      await api.post("/auth/not-me", { token });
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
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="m-0 text-3xl font-semibold text-kumo-default">{t("title")}</h1>
        <p className="text-lg text-pretty text-kumo-subtle">{t("lead")}</p>
      </div>
      {token ? null : <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={t("noToken")} />}
      {refused ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={refused} /> : null}
      <Button
        variant="destructive"
        size="lg"
        loading={busy}
        disabled={!token}
        className="w-full justify-center"
        onClick={() => void press()}
      >
        {t("submit")}
      </Button>
      <LinkButton href="/login" variant="ghost" size="lg" className="w-full justify-center">
        {t("toLogin")}
      </LinkButton>
    </div>
  );
}

// The token arrives in the query string, which the prerender does not have.
export default function NotMePage() {
  return (
    <Suspense>
      <NotMeForm />
    </Suspense>
  );
}
