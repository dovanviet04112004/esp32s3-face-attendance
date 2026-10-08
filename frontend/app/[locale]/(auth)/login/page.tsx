"use client";

import { Banner, Button, Input, Link, LinkButton } from "@cloudflare/kumo";
import { AndroidLogoIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useEffect, useState, type FormEvent } from "react";

import { AuthenticatorSetup, type OfferedSecret } from "@/components/auth/authenticator-setup";
import { BackupCodes } from "@/components/auth/backup-codes";
import { CodeField } from "@/components/auth/code-field";
import { PasswordField } from "@/components/ui/password-field";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { claimsOf, useSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { faultCode, useFault } from "@/lib/fault";
import { homeFor } from "@/lib/nav";

interface SessionAnswer {
  accessToken: string;
  email: string;
}

type LoginAnswer =
  | ({ step: "session" } & SessionAnswer)
  | { step: "code" | "enroll"; email: string; challenge: string; expiresInSeconds: number };

type Waiting = { at: "code"; email: string; challenge: string; until: number } | { at: "enroll"; email: string; challenge: string; until: number; offer: OfferedSecret };

// The password first; a role in MFA_ROLES then gives its code, or links an app the first time (KEHOACH 9.4).
type Stage = { at: "password" } | Waiting | { at: "codes"; codes: string[]; home: string };

const kWaitingKey = "login-waiting";

// A phone may drop the tab while its owner reads the authenticator; the ticket comes back for as long as it lives.
function heldStage(): Waiting | null {
  try {
    const held = JSON.parse(sessionStorage.getItem(kWaitingKey) ?? "null") as Waiting | null;
    return held && held.until > Date.now() ? held : null;
  } catch {
    return null;
  }
}

function holdStage(stage: Waiting | null): void {
  try {
    if (stage) {
      sessionStorage.setItem(kWaitingKey, JSON.stringify(stage));
    } else {
      sessionStorage.removeItem(kWaitingKey);
    }
  } catch {
    return;
  }
}

// An Android browser, not the app itself: the shell opens this page standalone, or from its own referrer.
function useAndroidBrowser(): boolean {
  const [android, setAndroid] = useState(false);
  useEffect(() => {
    const inApp = matchMedia("(display-mode: standalone)").matches || document.referrer.startsWith("android-app://");
    setAndroid(/Android/i.test(navigator.userAgent) && !inApp);
  }, []);
  return android;
}

function Heading({ title, lead }: { title: string; lead: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="m-0 text-3xl font-semibold text-kumo-default">{title}</h1>
      <p className="text-lg text-pretty text-kumo-subtle">{lead}</p>
    </div>
  );
}

export default function LoginPage() {
  const t = useTranslations("login");
  const mfa = useTranslations("mfa");
  const doors = useTranslations("doors");
  const router = useRouter();
  const setSession = useSession((s) => s.setSession);
  const faultOf = useFault();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<Stage>({ at: "password" });
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const android = useAndroidBrowser();

  useEffect(() => {
    const held = heldStage();
    if (held) {
      setStage(held);
    } else {
      holdStage(null);
    }
  }, []);

  function wait(next: Waiting): void {
    holdStage(next);
    setStage(next);
  }

  // Keep the session and say where its role lands.
  function keep(answer: SessionAnswer): string {
    holdStage(null);
    const claims = claimsOf(answer.accessToken);
    setSession(answer.accessToken, claims, answer.email);
    return homeFor(claims.role, claims.employeeId !== null);
  }

  function restart(): void {
    holdStage(null);
    setStage({ at: "password" });
    setCode("");
    setRefused(null);
  }

  // On the way to the home page the button stays busy: a form that looks reset reads as a failed sign-in.
  async function attempt(work: () => Promise<"leaving" | "staying">): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setRefused(null);
    try {
      if ((await work()) === "staying") {
        setBusy(false);
      }
    } catch (fell: unknown) {
      setCode("");
      if (faultCode(fell) === "MFA_CHALLENGE_SPENT") {
        holdStage(null);
        setStage({ at: "password" });
      }
      // The api answers CREDENTIALS_REJECTED for a wrong address and a wrong
      // password alike, so telling the truth here still says neither.
      setRefused(faultOf(fell));
      setBusy(false);
    }
  }

  function submitPassword(event: FormEvent): void {
    event.preventDefault();
    void attempt(async () => {
      const answer = (await api.post<LoginAnswer>("/auth/login", { email, password })).data;
      if (answer.step === "session") {
        router.replace(keep(answer));
        return "leaving";
      }
      setPassword("");
      const ticket = { email: answer.email, challenge: answer.challenge, until: Date.now() + answer.expiresInSeconds * 1000 };
      if (answer.step === "code") {
        wait({ at: "code", ...ticket });
      } else {
        const offer = (await api.post<OfferedSecret>("/auth/mfa/setup", { challenge: answer.challenge })).data;
        wait({ at: "enroll", ...ticket, offer });
      }
      return "staying";
    });
  }

  function submitCode(event: FormEvent, challenge: string): void {
    event.preventDefault();
    void attempt(async () => {
      router.replace(keep((await api.post<SessionAnswer>("/auth/mfa/verify", { challenge, code })).data));
      return "leaving";
    });
  }

  function submitEnrolment(event: FormEvent, challenge: string): void {
    event.preventDefault();
    void attempt(async () => {
      const enrolled = (await api.post<SessionAnswer & { backupCodes: string[] }>("/auth/mfa/confirm", { challenge, code })).data;
      setStage({ at: "codes", codes: enrolled.backupCodes, home: keep(enrolled) });
      return "staying";
    });
  }

  const banner = refused ? <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={refused} /> : null;
  const back = (
    <Button variant="ghost" className="self-center" onClick={restart}>
      {mfa("back")}
    </Button>
  );

  if (stage.at === "codes") {
    return (
      <div className="flex flex-col gap-6">
        <Heading title={mfa("codesTitle")} lead={mfa("codesLead")} />
        <BackupCodes codes={stage.codes} />
        <Button variant="primary" size="lg" className="w-full justify-center" onClick={() => router.replace(stage.home)}>
          {mfa("codesKept")}
        </Button>
      </div>
    );
  }

  if (stage.at === "code") {
    return (
      <form onSubmit={(event) => submitCode(event, stage.challenge)} className="flex flex-col gap-6">
        <Heading title={mfa("codeTitle")} lead={mfa("codeLead", { email: stage.email })} />
        <CodeField value={code} onChange={setCode} />
        {banner}
        <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full justify-center">
          {mfa("verify")}
        </Button>
        {back}
      </form>
    );
  }

  if (stage.at === "enroll") {
    return (
      <form onSubmit={(event) => submitEnrolment(event, stage.challenge)} className="flex flex-col gap-6">
        <Heading title={mfa("enrollTitle")} lead={mfa("enrollLead", { email: stage.email })} />
        <ol className="m-0 flex list-decimal flex-col gap-5 ps-5 marker:text-kumo-subtle">
          <li>{mfa("enrollInstall")}</li>
          <li>
            <div className="flex flex-col gap-3">
              <span>{mfa("enrollScan")}</span>
              <AuthenticatorSetup offer={stage.offer} />
            </div>
          </li>
          <li>
            <div className="flex flex-col gap-3">
              <span>{mfa("enrollType")}</span>
              <CodeField value={code} onChange={setCode} allowBackup={false} autoFocus={false} />
            </div>
          </li>
        </ol>
        {banner}
        <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full justify-center">
          {mfa("enrollGo")}
        </Button>
        {back}
      </form>
    );
  }

  return (
    <form onSubmit={submitPassword} className="flex flex-col gap-6">
      <Heading title={t("title")} lead={t("lead")} />
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
      {banner}
      <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full justify-center">
        {t("submit")}
      </Button>
      <p className="text-sm text-pretty text-kumo-subtle">{doors("invited")}</p>
      {android ? (
        <div className="flex flex-col gap-2 border-t border-kumo-hairline pt-5">
          <LinkButton href={env.NEXT_PUBLIC_ANDROID_APK_URL} variant="secondary" icon={AndroidLogoIcon} className="w-full justify-center">
            {t("androidApp")}
          </LinkButton>
          <p className="text-sm text-pretty text-kumo-subtle">{t("androidAppLead")}</p>
        </div>
      ) : null}
    </form>
  );
}
