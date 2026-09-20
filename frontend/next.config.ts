import createNextIntlPlugin from "next-intl/plugin";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  // Dev writes AGENTS.md and CLAUDE.md beside this file, and neither path is
  // in the plan's tree (KEHOACH 4).
  agentRules: false,
};

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

export default withNextIntl(config);
