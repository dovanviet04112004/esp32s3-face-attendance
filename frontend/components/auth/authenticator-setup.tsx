"use client";

import { Button } from "@cloudflare/kumo";
import { CopyIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { encode } from "uqr";

import { useNotify } from "@/components/ui/notify";

const kQuietModules = 4;
const kSecretGroup = 4;
const kGroupsPerLine = 4;

/** The secret on offer at enrolment, as the server hands it out (KEHOACH 9.4). */
export interface OfferedSecret {
  secret: string;
  uri: string;
}

// Drawn here from the URI, so the secret never reaches a QR service.
function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(text, { ecc: "M", border: kQuietModules });
    const modules = qr.data.flatMap((row, y) => row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : "")));
    return { size: qr.size, path: modules.join("") };
  }, [text]);
  // Dark modules on a light ground in both themes: that is what scanners read.
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges" className="size-48 rounded-lg">
      <rect width={size} height={size} fill="white" />
      <path d={path} fill="black" />
    </svg>
  );
}

/** The QR to scan, and the same secret in groups of four for an app that cannot scan. */
export function AuthenticatorSetup({ offer }: { offer: OfferedSecret }) {
  const t = useTranslations("mfa");
  const notify = useNotify();
  const groups = offer.secret.match(new RegExp(`.{1,${kSecretGroup}}`, "g")) ?? [offer.secret];
  const lines = Array.from({ length: Math.ceil(groups.length / kGroupsPerLine) }, (_, at) =>
    groups.slice(at * kGroupsPerLine, (at + 1) * kGroupsPerLine).join(" "),
  );

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(offer.secret);
      notify.done(t("secretCopied"));
    } catch {
      notify.failed(t("copyBlocked"));
    }
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <QrCode text={offer.uri} label={t("qrLabel")} />
      <div className="flex w-full flex-col gap-1.5">
        <p className="text-sm text-kumo-subtle">{t("secretLabel")}</p>
        <div className="flex items-start gap-2 rounded-lg border border-kumo-line bg-kumo-base py-1.5 ps-3 pe-1.5">
          <code className="flex min-w-0 flex-1 flex-col py-1 font-mono text-base break-words">
            {lines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </code>
          <Button variant="ghost" size="sm" shape="square" icon={CopyIcon} aria-label={t("copy")} onClick={() => void copy()} />
        </div>
      </div>
    </div>
  );
}
