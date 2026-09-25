"use client";

import { Banner, Switch } from "@cloudflare/kumo";
import { DeviceMobileIcon, InfoIcon, WarningIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { useNotify } from "@/components/ui/notify";
import { api } from "@/lib/api";
import { env } from "@/lib/env";

type Standing = "unsupported" | "install" | "blocked" | "off" | "on";

/** iOS pushes only to an app added to the home screen, and Safari there has no PushManager (KEHOACH 9.21.6). */
function iosOutsideTheApp(): boolean {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const installed =
    window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  return ios && !installed;
}

/** A VAPID key arrives base64url and the browser wants raw bytes. */
function toBytes(key: string): Uint8Array<ArrayBuffer> {
  const padded = (key + "=".repeat((4 - (key.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let at = 0; at < raw.length; at += 1) {
    bytes[at] = raw.charCodeAt(at);
  }
  return bytes;
}

export function PushSwitch() {
  const t = useTranslations("notices");
  const notify = useNotify();
  const [standing, setStanding] = useState<Standing>("unsupported");

  useEffect(() => {
    if (iosOutsideTheApp()) {
      setStanding("install");
      return;
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) {
      return;
    }
    const read = () => {
      if (Notification.permission === "denied") {
        setStanding("blocked");
        return;
      }
      void navigator.serviceWorker.ready
        .then((worker) => worker.pushManager.getSubscription())
        .then((held) => setStanding(held ? "on" : "off"));
    };
    // A blocked permission is lifted in the browser's own settings, so look again on the way back.
    const back = () => {
      if (document.visibilityState === "visible") {
        read();
      }
    };
    read();
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, []);

  const turnOn = useMutation({
    mutationFn: async () => {
      const allowed = await Notification.requestPermission();
      if (allowed !== "granted") {
        setStanding("blocked");
        return false;
      }
      const worker = await navigator.serviceWorker.ready;
      const sub = await worker.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: toBytes(env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ""),
      });
      const raw = sub.toJSON();
      await api.post("/notifications/subscribe", {
        endpoint: sub.endpoint,
        p256dh: raw.keys?.p256dh,
        auth: raw.keys?.auth,
        userAgent: navigator.userAgent.slice(0, 200),
      });
      setStanding("on");
      return true;
    },
    onSuccess: (on) => on && notify.done(t("pushTurnedOn")),
    onError: notify.failed,
  });

  const turnOff = useMutation({
    mutationFn: async () => {
      const worker = await navigator.serviceWorker.ready;
      const held = await worker.pushManager.getSubscription();
      if (held) {
        await api.delete(`/notifications/subscribe?endpoint=${encodeURIComponent(held.endpoint)}`);
        await held.unsubscribe();
      }
      setStanding("off");
    },
    onSuccess: () => notify.done(t("pushTurnedOff")),
    onError: notify.failed,
  });

  if (standing === "install") {
    return (
      <Banner
        variant="secondary"
        size="sm"
        icon={<DeviceMobileIcon weight="fill" />}
        title={t("pushInstallTitle")}
        description={t("pushInstallSteps")}
      />
    );
  }
  if (standing === "unsupported") {
    return <Banner variant="secondary" size="sm" icon={<InfoIcon weight="fill" />} description={t("pushUnsupported")} />;
  }
  if (standing === "blocked") {
    return <Banner variant="alert" size="sm" icon={<WarningIcon weight="fill" />} description={t("pushBlocked")} />;
  }

  const busy = turnOn.isPending || turnOff.isPending;
  return (
    <Switch
      label={standing === "on" ? t("pushOn") : t("pushOff")}
      checked={standing === "on"}
      disabled={busy}
      transitioning={busy}
      onCheckedChange={(on: boolean) => (on ? turnOn.mutate() : turnOff.mutate())}
    />
  );
}
