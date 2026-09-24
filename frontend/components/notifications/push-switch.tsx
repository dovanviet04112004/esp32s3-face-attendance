"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { env } from "@/lib/env";

type Standing = "unsupported" | "blocked" | "off" | "on";

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
  const common = useTranslations("common");
  const [standing, setStanding] = useState<Standing>("unsupported");

  useEffect(() => {
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
        return;
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
    },
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
  });

  if (standing === "unsupported") {
    return <p className="text-sm text-(--color-muted)">{t("pushUnsupported")}</p>;
  }
  if (standing === "blocked") {
    return <p className="text-sm text-(--color-warn)">{t("pushBlocked")}</p>;
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm text-(--color-muted)">
        {standing === "on" ? t("pushOn") : t("pushOff")}
      </span>
      {standing === "on" ? (
        <Button type="button" tone="quiet" disabled={turnOff.isPending} onClick={() => turnOff.mutate()}>
          {turnOff.isPending ? common("saving") : t("pushDisable")}
        </Button>
      ) : (
        <Button type="button" disabled={turnOn.isPending} onClick={() => turnOn.mutate()}>
          {turnOn.isPending ? common("saving") : t("pushEnable")}
        </Button>
      )}
    </div>
  );
}
