"use client";

import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { claimsOf, useSession } from "@/lib/auth";
import { useFault } from "@/lib/fault";

export default function LoginPage() {
  const t = useTranslations("login");
  const app = useTranslations("app");
  const router = useRouter();
  const setSession = useSession((s) => s.setSession);
  const faultOf = useFault();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setRefused(null);
    try {
      const res = await api.post<{ accessToken: string }>("/auth/login", { email, password });
      const token = res.data.accessToken;
      setSession(token, claimsOf(token));
      router.replace("/overview");
    } catch (fell: unknown) {
      // The api answers CREDENTIALS_REJECTED for a wrong address and a wrong
      // password alike, so telling the truth here still says neither.
      setRefused(faultOf(fell));
    } finally {
      setBusy(false);
    }
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
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1"
        />

        <label className="mt-4 block text-sm font-medium" htmlFor="password">
          {t("password")}
        </label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1"
        />

        {refused ? (
          <p role="alert" className="mt-4 text-sm text-(--color-danger)">
            {refused}
          </p>
        ) : null}

        <Button type="submit" disabled={busy} className="mt-6 w-full">
          {busy ? t("checking") : t("submit")}
        </Button>
      </form>
    </main>
  );
}
