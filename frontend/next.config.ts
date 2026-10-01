import createNextIntlPlugin from "next-intl/plugin";
import type { NextConfig } from "next";

import { env, isProduction } from "./lib/env";

// Next inlines RSC data as scripts, and a statically rendered page has no per-request nonce (KEHOACH 7.2).
const kScripts = isProduction ? "'self' 'unsafe-inline'" : "'self' 'unsafe-inline' 'unsafe-eval'";

const kPolicy = [
  "default-src 'self'",
  `script-src ${kScripts}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self' ${new URL(env.NEXT_PUBLIC_API_URL).origin} ${new URL(env.NEXT_PUBLIC_WS_URL).origin}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const config: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  poweredByHeader: false,
  // Dev writes AGENTS.md and CLAUDE.md beside this file, and neither path is
  // in the plan's tree (KEHOACH 4).
  agentRules: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: kPolicy },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=()" },
        ],
      },
    ];
  },
};

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

export default withNextIntl(config);
