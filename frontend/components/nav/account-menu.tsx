"use client";

import { Button, DropdownMenu, LayerDialog } from "@cloudflare/kumo";
import {
  GearIcon,
  KeyIcon,
  MonitorIcon,
  MoonIcon,
  SignOutIcon,
  SunIcon,
  UserCircleIcon,
} from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";

import { pushHere } from "@/components/notifications/push-switch";
import { Link, useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { dropOwned, useOutbox } from "@/lib/outbox";
import { applyTheme, asTheme, readTheme, type Theme } from "@/lib/theme";

const THEME_ICON = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;
const THEME_KEY = { system: "themeSystem", light: "themeLight", dark: "themeDark" } as const;

/** The cookie dies at the server, the store and every cache here, and the page goes to the
 *  form: a half-done sign-out leaves somebody looking signed in (KEHOACH 9.12). Requests still
 *  waiting on this device are named and dropped only once the person agrees (KEHOACH 9.21.3).
 */
export function useSignOut(): { start: () => void; isPending: boolean; confirm: ReactNode } {
  const t = useTranslations("nav");
  const common = useTranslations("common");
  const router = useRouter();
  const signOut = useSession((s) => s.signOut);
  const me = useSession((s) => s.userId);
  const unsent = useOutbox();
  const [asking, setAsking] = useState(false);
  const leave = () => {
    signOut();
    router.replace("/login");
  };
  // An unreachable server still signs this browser out; its session ends on its own clock.
  const leaving = useMutation({
    networkMode: "always",
    mutationFn: async () => {
      const device = await pushHere();
      try {
        await api.post("/auth/logout", device ? { pushEndpoint: device.endpoint } : {});
      } finally {
        // A shared device must not keep showing this account's notices (KEHOACH 9.21.4).
        await device?.unsubscribe().catch(() => false);
      }
    },
    onSuccess: leave,
    onError: leave,
  });
  const confirm = (
    <LayerDialog.Alert open={asking} onOpenChange={setAsking} dismissDisabled={leaving.isPending}>
      <LayerDialog.Content closeLabel={common("close")}>
        <LayerDialog.Title>{t("unsentTitle")}</LayerDialog.Title>
        <LayerDialog.Body>
          <p className="m-0 text-pretty">{t("unsentLead", { count: unsent.length })}</p>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel={t("unsentStay")}>
          <LayerDialog.Actions.Primary
            variant="destructive"
            loading={leaving.isPending}
            onClick={async () => {
              if (me) {
                await dropOwned(me);
              }
              leaving.mutate();
            }}
          >
            {t("unsentDrop")}
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Alert>
  );
  return {
    start: () => (unsent.length > 0 ? setAsking(true) : leaving.mutate()),
    isPending: leaving.isPending,
    confirm,
  };
}

/** Account actions sit two deliberate clicks away, never beside the daily ones (KEHOACH 9.12). */
export function AccountMenu() {
  const t = useTranslations("nav");
  const s = useTranslations("settings");
  const roleName = useTranslations("roles");
  const role = useSession((one) => one.role);
  const email = useSession((one) => one.email);
  const leaving = useSignOut();
  const [theme, setTheme] = useState<Theme>("system");

  // The server has no cookie jar to read, so the stored choice lands after mount.
  useEffect(() => setTheme(readTheme()), []);

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={<Button variant="ghost" shape="square" icon={UserCircleIcon} aria-label={t("account")} />}
      />
      <DropdownMenu.Content align="end" className="w-64 max-w-[calc(100vw-2rem)]">
        <DropdownMenu.Group>
          <DropdownMenu.Label className="flex min-w-0 flex-col gap-0.5">
            {email ? <span className="truncate font-medium text-kumo-default">{email}</span> : null}
            <span className="truncate text-kumo-subtle">{role ? roleName(role) : t("account")}</span>
          </DropdownMenu.Label>
          <DropdownMenu.Separator />
          <DropdownMenu.LinkItem icon={GearIcon} render={<Link href="/settings" />}>
            {t("settings")}
          </DropdownMenu.LinkItem>
          <DropdownMenu.LinkItem icon={KeyIcon} render={<Link href="/change-password" />}>
            {t("changePassword")}
          </DropdownMenu.LinkItem>
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        <DropdownMenu.RadioGroup
          value={theme}
          onValueChange={(next: string) => {
            const picked = asTheme(next);
            setTheme(picked);
            applyTheme(picked);
          }}
        >
          <DropdownMenu.Label className="text-sm font-medium text-kumo-subtle">{s("themeTitle")}</DropdownMenu.Label>
          {(["system", "light", "dark"] as const).map((one) => (
            <DropdownMenu.RadioItem key={one} value={one} icon={THEME_ICON[one]}>
              {s(THEME_KEY[one])}
              <DropdownMenu.RadioItemIndicator />
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
        <DropdownMenu.Separator />
        <DropdownMenu.Item icon={SignOutIcon} variant="danger" disabled={leaving.isPending} onClick={leaving.start}>
          {leaving.isPending ? t("signingOut") : t("signOut")}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
      {leaving.confirm}
    </DropdownMenu>
  );
}
