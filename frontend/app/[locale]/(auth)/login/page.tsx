"use client";

import { Banner, Button, Input, Link } from "@cloudflare/kumo";
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
  const doors = useTranslations("doors");
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
      const res = await api.post<{ accessToken: string; email?: string }>("/auth/login", { email, password });
      const token = res.data.accessToken;
      const claims = claimsOf(token);
      setSession(token, claims, res.data.email ?? email.trim());
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
    <form onSubmit={submit} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="m-0 text-3xl font-semibold text-kumo-default">{t("title")}</h1>
        <p className="text-lg text-pretty text-kumo-subtle">{t("lead")}</p>
      </div>
      <div className="flex flex-col gap-5">
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
        <PasswordField
          size="lg"
          label={t("password")}
          labelAside={<Link href="/forgot-password">{t("forgot")}</Link>}
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      {refused ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={refused} /> : null}
      <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full justify-center">
        {t("submit")}
      </Button>
      <p className="text-sm text-pretty text-kumo-subtle">{doors("invited")}</p>
    </form>
  );
}
