import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// The migrate CLI is its own process, so it loads .env itself: it never starts
// Nest and cannot reach ConfigModule (KEHOACH 4.9).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
