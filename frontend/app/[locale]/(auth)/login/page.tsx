"use client";

import { Banner, Button, Input, LayerCard, Link } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { PasswordField } from "@/components/ui/password-field";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { claimsOf, useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";
import { homeFor } from "@/lib/nav";

export default function LoginPage() {
  const t = useTranslations("login");
  const router = useRouter();
  const setSession = useSession((s) => s.setSession);
  const faultOf = useFault();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setRefused(null);
    try {
      const res = await api.post<{ accessToken: string }>("/auth/login", { email, password });
      const token = res.data.accessToken;
      const claims = claimsOf(token);
      setSession(token, claims);
      router.replace(homeFor(claims.role, claims.employeeId !== null));
    } catch (fell: unknown) {
      // The api answers CREDENTIALS_REJECTED for a wrong address and a wrong
      // password alike, so telling the truth here still says neither.
      setRefused(faultOf(fell));
    } finally {
      setBusy(false);
    }
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
          <PasswordField
            label={t("password")}
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {refused ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={refused} /> : null}
          <Button type="submit" variant="primary" loading={busy} className="w-full justify-center">
            {t("submit")}
          </Button>
        </form>
      </LayerCard.Primary>
    </LayerCard>
    <p className="text-center">
      <Link href="/forgot-password">{t("forgot")}</Link>
    </p>
    </>
  );
}
