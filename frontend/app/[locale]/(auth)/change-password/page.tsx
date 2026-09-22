"use client";

import { CircleCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/input";
import { Link, useRouter } from "@/i18n/navigation";
import { api, reopenSession } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";

const SHORTEST = 12;

export default function ChangePasswordPage() {
  const t = useTranslations("changePassword");
  const app = useTranslations("app");
  const common = useTranslations("common");
  const router = useRouter();
  const accessToken = useSession((s) => s.accessToken);
  const clear = useSession((s) => s.clear);
  const faultOf = useFault();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
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
      clear();
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
          <CircleCheck className="mx-auto size-8 text-(--color-ok)" aria-hidden />
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

        <label className="mt-6 block text-sm font-medium" htmlFor="current">
          {t("current")}
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

        <label className="mt-4 block text-sm font-medium" htmlFor="next">
          {t("next")}
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
        <p className="mt-1 text-xs text-(--color-muted)">{t("hint", { count: SHORTEST })}</p>

        <p className="mt-4 text-sm text-(--color-warn)">{t("warn")}</p>

        {refused ? (
          <p role="alert" className="mt-4 text-sm text-(--color-danger)">
            {refused}
          </p>
        ) : null}

        <Button type="submit" disabled={busy} className="mt-6 w-full">
          {busy ? t("saving") : t("submit")}
        </Button>

        <p className="mt-4 text-center text-sm text-(--color-muted)">
          <Link href="/settings" className="underline">
            {t("back")}
          </Link>
        </p>
      </form>
    </main>
  );
}
