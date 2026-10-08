"use client";

import { Button, LayerCard, LinkButton, TableOfContents, Tabs, useTableOfContentsActiveId } from "@cloudflare/kumo";
import { BookOpenTextIcon, EnvelopeSimpleIcon, KeyIcon, SignOutIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";

import { TwoStep, useTwoStep } from "@/components/auth/two-step";
import { useSignOut } from "@/components/nav/account-menu";
import { NoticePreferences } from "@/components/notifications/notice-prefs";
import { PushDevices } from "@/components/notifications/push-devices";
import { PushSwitch } from "@/components/notifications/push-switch";
import { useNotify } from "@/components/ui/notify";
import { AsideCard, Facts, PageHeader, PageLayout } from "@/components/ui/page";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing, type Locale } from "@/i18n/routing";
import { api } from "@/lib/api";
import { env } from "@/lib/env";
import { useSession, type Role } from "@/lib/auth";
import { rememberLanguage } from "@/lib/theme";

interface OpenedAccount {
  employeeCode: string;
  email: string;
  role: Role;
}

// The top bar is 58 px and sticks, so a section scrolled to lands just under it.
const kTopBarPx = 72;
const kUserScroll = ["wheel", "touchmove", "keydown"] as const;

function onScroll(changed: () => void): () => void {
  window.addEventListener("scroll", changed, { passive: true });
  window.addEventListener("resize", changed);
  return () => {
    window.removeEventListener("scroll", changed);
    window.removeEventListener("resize", changed);
  };
}

function scrolledToEnd(): boolean {
  const end = document.documentElement.scrollHeight - window.innerHeight;
  return end > 2 && window.scrollY >= end - 2;
}

// Kumo lights the topmost section in view, so the short sections at the foot of the page never win by scrolling.
function useSectionSpy(ids: string[]) {
  const spy = useTableOfContentsActiveId({ ids, offset: kTopBarPx });
  const [picked, setPicked] = useState<string | null>(null);
  const atEnd = useSyncExternalStore(onScroll, scrolledToEnd, () => false);
  useEffect(() => {
    const release = () => setPicked(null);
    for (const type of kUserScroll) {
      window.addEventListener(type, release, { passive: true });
    }
    return () => {
      for (const type of kUserScroll) {
        window.removeEventListener(type, release);
      }
    };
  }, []);
  return {
    activeId: picked ?? (atEnd ? (ids.at(-1) ?? null) : spy.activeId),
    selectSection: (id: string) => {
      setPicked(id);
      spy.selectSection(id);
    },
  };
}

function Section({ id, title, lead, children }: { id: string; title: string; lead?: string; children: ReactNode }) {
  return (
    <LayerCard id={id} className="scroll-mt-20">
      <LayerCard.Secondary>{title}</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col items-start gap-3">
        {lead ? <p className="text-kumo-subtle">{lead}</p> : null}
        {children}
      </LayerCard.Primary>
    </LayerCard>
  );
}

export default function SettingsPage() {
  const t = useTranslations("settings");
  const roleName = useTranslations("roles");
  const notices = useTranslations("notices");
  const nav = useTranslations("nav");
  const mfa = useTranslations("mfa");
  const locale = useLocale();
  const here = usePathname();
  const router = useRouter();
  const notify = useNotify();
  const role = useSession((s) => s.role);
  const leaving = useSignOut();
  const [moving, startMoving] = useTransition();
  const cache = useQueryClient();
  const twoStep = useTwoStep();
  const twoStepShown = twoStep.data && (twoStep.data.required || twoStep.data.enabledAt !== null) ? twoStep.data : null;

  const provision = useMutation({
    mutationFn: async () =>
      (await api.post<{ accounts: OpenedAccount[]; waiting: number }>("/users/provision")).data,
    onSuccess: (done) => {
      notify.done(t("provisionDone", { count: done.accounts.length }));
      void cache.invalidateQueries({ queryKey: ["users"] });
      void cache.invalidateQueries({ queryKey: ["employees"] });
    },
    onError: notify.failed,
  });

  const reference = useMutation({
    mutationFn: async (tab: Window) => {
      const { pass } = (await api.post<{ pass: string }>("/auth/docs-pass")).data;
      tab.location.href = `${env.NEXT_PUBLIC_API_URL}/docs?pass=${encodeURIComponent(pass)}`;
    },
    onSuccess: () => notify.done(t("docsOpened")),
    onError: (fell, tab) => {
      tab.close();
      notify.failed(fell);
    },
  });

  // The tab opens inside the click, where the browser allows it; the pass arrives after.
  function openReference(): void {
    const tab = window.open("", "_blank");
    if (!tab) {
      notify.failed(t("docsBlocked"));
      return;
    }
    tab.opener = null;
    reference.mutate(tab);
  }

  const sections = [
    { id: "language", title: t("languageTitle") },
    { id: "theme", title: t("themeTitle") },
    { id: "push", title: notices("pushTitle") },
    { id: "devices", title: notices("devicesTitle") },
    { id: "notices", title: notices("prefsTitle") },
    ...(role === "ADMIN" ? [{ id: "provision", title: t("provisionTitle") }, { id: "docs", title: t("docsTitle") }] : []),
    ...(twoStepShown ? [{ id: "two-step", title: mfa("title") }] : []),
    { id: "account", title: t("accountTitle") },
  ];
  const { activeId, selectSection } = useSectionSpy(sections.map((one) => one.id));

  function choose(next: string) {
    if (next === locale || !routing.locales.includes(next as Locale)) {
      return;
    }
    // Same page, other language: the locale rides on the URL, so this is a move.
    rememberLanguage(next);
    startMoving(() => router.replace(here, { locale: next as Locale }));
  }

  return (
    <>
      <PageHeader title={t("title")} description={t("lead")} />
      <PageLayout
        aside={
          <div className="hidden md:block">
            <AsideCard title={t("onThisPage")}>
              <TableOfContents>
                <TableOfContents.List>
                  {sections.map((one) => (
                    <TableOfContents.Item
                      key={one.id}
                      href={`#${one.id}`}
                      active={(activeId ?? sections[0].id) === one.id}
                      onClick={() => selectSection(one.id)}
                    >
                      {one.title}
                    </TableOfContents.Item>
                  ))}
                </TableOfContents.List>
              </TableOfContents>
            </AsideCard>
          </div>
        }
      >
        <div className="flex flex-col gap-6">
          <Section id="language" title={t("languageTitle")} lead={t("languageLead")}>
            <Tabs
              variant="segmented"
              value={locale}
              onValueChange={choose}
              tabs={routing.locales.map((code) => ({
                value: code,
                label: (
                  <span lang={code} className={moving ? "opacity-60" : undefined}>
                    {t(code)}
                  </span>
                ),
              }))}
            />
          </Section>

          <Section id="theme" title={t("themeTitle")} lead={t("themeLead")}>
            <ThemeToggle />
          </Section>

          <Section id="push" title={notices("pushTitle")} lead={notices("pushLead")}>
            <PushSwitch />
          </Section>

          <Section id="devices" title={notices("devicesTitle")} lead={notices("devicesLead")}>
            <PushDevices />
          </Section>

          <Section id="notices" title={notices("prefsTitle")} lead={notices("prefsLead")}>
            <div className="w-full">
              <NoticePreferences />
            </div>
          </Section>

          {role === "ADMIN" ? (
            <Section id="provision" title={t("provisionTitle")} lead={t("provisionLead")}>
              <Button variant="secondary" icon={EnvelopeSimpleIcon} loading={provision.isPending} onClick={() => provision.mutate()}>
                {t("provisionRun")}
              </Button>
              {provision.data?.accounts.length === 0 ? <p className="text-kumo-subtle">{t("provisionNone")}</p> : null}
              {provision.data?.accounts.length ? (
                <div className="flex w-full flex-col gap-2">
                  <p>{t("provisionOnce")}</p>
                  {provision.data.waiting > 0 ? (
                    <p className="text-kumo-warning">{t("provisionWaiting", { count: provision.data.waiting })}</p>
                  ) : null}
                  <ul className="flex flex-col font-mono text-sm">
                    {provision.data.accounts.map((one) => (
                      <li key={one.email} className="flex flex-wrap gap-x-3 border-b border-kumo-hairline py-1.5 last:border-0">
                        <span className="min-w-20">{one.employeeCode}</span>
                        <span className="min-w-0 flex-1 truncate">{one.email}</span>
                        <span className="font-sans text-kumo-subtle">{roleName(one.role)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </Section>
          ) : null}

          {role === "ADMIN" ? (
            <Section id="docs" title={t("docsTitle")} lead={t("docsLead")}>
              <Button variant="secondary" icon={BookOpenTextIcon} loading={reference.isPending} onClick={openReference}>
                {t("docsOpen")}
              </Button>
            </Section>
          ) : null}

          {twoStepShown ? (
            <Section id="two-step" title={mfa("title")} lead={mfa("lead")}>
              <TwoStep status={twoStepShown} />
            </Section>
          ) : null}

          <Section id="account" title={t("accountTitle")}>
            <div className="w-full">
              <Facts rows={[[t("role"), role ? roleName(role) : nav("account")]]} />
            </div>
            <div className="flex w-full flex-col gap-3 border-t border-kumo-hairline pt-3">
              <p className="font-medium">{t("passwordTitle")}</p>
              <p className="text-kumo-subtle">{t("passwordLead")}</p>
              <div className="flex flex-wrap gap-2">
                <LinkButton href="/change-password" variant="secondary" icon={KeyIcon}>
                  {t("passwordGo")}
                </LinkButton>
                <Button variant="secondary-destructive" icon={SignOutIcon} loading={leaving.isPending} onClick={leaving.start}>
                  {nav("signOut")}
                </Button>
              </div>
              {leaving.confirm}
            </div>
          </Section>
        </div>
      </PageLayout>
    </>
  );
}
