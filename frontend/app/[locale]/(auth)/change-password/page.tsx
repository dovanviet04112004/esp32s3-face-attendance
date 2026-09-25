"use client";

import { Banner, Button, LayerCard, Link, LinkButton } from "@cloudflare/kumo";
import { CheckCircleIcon, WarningCircleIcon, WarningIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useEffect, useState, type FormEvent } from "react";

import { PasswordField } from "@/components/ui/password-field";
import { useRouter } from "@/i18n/navigation";
import { api, reopenSession } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";

const SHORTEST = 12;

export default function ChangePasswordPage() {
  const t = useTranslations("changePassword");
  const router = useRouter();
  const accessToken = useSession((s) => s.accessToken);
  const signOut = useSession((s) => s.signOut);
  const faultOf = useFault();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [shown, setShown] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // Signing this session out is the point, so the done card outlives the token.
  useEffect(() => {
    if (done || accessToken) {
      return;
    }
    void reopenSession().then((token) => {
      if (!token) {
        router.replace("/login");
      }
    });
  }, [done, accessToken, router]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setRefused(null);
    try {
      await api.post("/auth/change-password", { current, next });
      setCurrent("");
      setNext("");
      setDone(true);
      signOut();
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
            <PasswordField
              label={t("current")}
              shown={shown}
              onShownChange={setShown}
              autoComplete="current-password"
              required
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
            />
            <PasswordField
              label={t("next")}
              description={t("hint", { count: SHORTEST })}
              shown={shown}
              toggle={false}
              autoComplete="new-password"
              required
              minLength={SHORTEST}
              value={next}
              onChange={(event) => setNext(event.target.value)}
            />
            <Banner variant="alert" size="sm" icon={<WarningIcon weight="fill" />} description={t("warn")} />
            {refused ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={refused} /> : null}
            <Button type="submit" variant="primary" loading={busy} className="w-full justify-center">
              {t("submit")}
            </Button>
          </form>
        </LayerCard.Primary>
      </LayerCard>
      <p className="text-center"><Link href="/settings">{t("back")}</Link></p>
    </>
  );
}
