import { z } from "zod";

const JWT_SECRETS = ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "JWT_DEVICE_SECRET"] as const;

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),

    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),

    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    JWT_ACCESS_TTL: z.string().min(1).default("15m"),
    JWT_REFRESH_TTL: z.string().min(1).default("7d"),

    DEVICE_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(90),
    DEVICE_BOOTSTRAP_TOKEN: z.string().min(16),
    DEVICE_CLAIM_ATTEMPTS: z.coerce.number().int().positive().max(20).default(5),
    DEVICE_POLL_INTERVAL_S: z.coerce.number().int().min(1).max(300).default(5),
    ENROLL_SESSION_MINUTES: z.coerce.number().int().positive().max(120).default(10),
    JWT_DEVICE_SECRET: z.string().min(32),

    LOGIN_ATTEMPTS_PER_MINUTE: z.coerce.number().int().positive().default(5),
    SESSIONS_PER_USER: z.coerce.number().int().positive().default(10),
    DEVICE_REGISTER_ATTEMPTS_PER_MINUTE: z.coerce.number().int().positive().default(60),
    FORGOT_ATTEMPTS_PER_HOUR: z.coerce.number().int().positive().default(5),
    API_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(600),
    HEAVY_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(20),
    LOGIN_LOCK_AFTER: z.coerce.number().int().min(3).max(100).default(10),
    LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().max(1440).default(15),
    // Proxies between the client and api; 0 trusts no X-Forwarded-For (KEHOACH 4.8).
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(4).default(0),
    PROVISION_BATCH: z.coerce.number().int().positive().max(10000).default(2000),
    PASSWORD_SETUP_TTL_HOURS: z.coerce.number().int().positive().default(72),
    DISPUTE_ANSWER_DAYS: z.coerce.number().int().positive().default(5),
    BACKUP_STALE_HOURS: z.coerce.number().int().min(0).max(168).default(0),
    BIOMETRIC_NOTICE_VERSION: z.string().min(1).max(64).default("2026-01-v1"),
    OTA_MAX_BYTES: z.coerce.number().int().positive().default(2_883_584),
    RELEASE_DIR: z.string().min(1).default("./releases"),
    RELEASE_LINK_HOURS: z.coerce.number().int().positive().max(168).default(24),
    OTA_BUSY_MINUTES: z.coerce.number().int().positive().max(1440).default(10),
    API_PUBLIC_URL: z
      .string()
      .url()
      .refine((held) => held.startsWith("https://"), "API_PUBLIC_URL must be https")
      .default("https://localhost"),
    RELEASE_PUBLISH_TOKEN: z
      .string()
      .optional()
      .transform((held) => (held ? held : undefined))
      .refine((held) => held === undefined || held.length >= 32, "RELEASE_PUBLISH_TOKEN needs 32 characters"),

    // The server clock is UTC, so this decides every day boundary (KEHOACH 9.8).
    APP_TIMEZONE: z
      .string()
      .min(1)
      .default("Asia/Ho_Chi_Minh")
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      }, "APP_TIMEZONE must be an IANA zone name"),

    SEED_ADMIN_PASSWORD: z.string().min(8).optional(),

    TEMPLATE_ENCRYPTION_KEY: z.string().min(44),

    // Empty is how .env.example turns it off, so empty must read as unset.
    NOTIFY_WEBHOOK_URL: z
      .string()
      .optional()
      .transform((held) => (held ? held : undefined)),

    CORS_ORIGIN: z.string().min(1),
    API_DOCS_ENABLED: z
      .enum(["true", "false", ""])
      .optional()
      .transform((held) => (held ? held === "true" : undefined)),

    // No host is how a deployment turns payslip mail off (KEHOACH 9.11).
    MAIL_HOST: z
      .string()
      .optional()
      .transform((held) => (held ? held : undefined)),
    MAIL_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    MAIL_USER: z
      .string()
      .optional()
      .transform((held) => (held ? held : undefined)),
    MAIL_PASSWORD: z
      .string()
      .optional()
      .transform((held) => (held ? held : undefined)),
    MAIL_FROM: z
      .string()
      .optional()
      .transform((held) => (held ? held : undefined)),
    APP_PUBLIC_URL: z.string().min(1),

    // No public key is how a deployment turns push off (KEHOACH 9.21.4).
    VAPID_PUBLIC_KEY: z
      .string()
      .optional()
      .transform((held) => (held ? held : undefined)),
    VAPID_PRIVATE_KEY: z
      .string()
      .optional()
      .transform((held) => (held ? held : undefined)),
    VAPID_SUBJECT: z.string().default("mailto:no-reply@example.com"),
    // Push services a subscription may point at; a leading dot allows the subdomains (KEHOACH 7.2).
    PUSH_ENDPOINT_HOSTS: z
      .string()
      .default("fcm.googleapis.com,updates.push.services.mozilla.com,.push.apple.com,.notify.windows.com")
      .transform((listed) => listed.split(",").map((one) => one.trim().toLowerCase()).filter(Boolean)),

    MQTT_URL: z.string().min(1),
    MQTT_USERNAME: z.string().min(1),
    MQTT_PASSWORD: z.string().min(1),
    MQTT_CA_CERT_PATH: z.string().optional(),
    // The broker's REST api, which closes a revoked kiosk's session (KEHOACH 7.4).
    EMQX_API_URL: z.string().url().optional(),
    EMQX_API_USERNAME: z.string().min(1).default("admin"),
    EMQX_API_PASSWORD: z.string().min(1).optional(),
  })
  // Without a host the mailer logs and drops, and the bank-change warning that
  // makes a payout change safe stops leaving the machine (KEHOACH 9.11).
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && env.MAIL_HOST === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["MAIL_HOST"],
        message: "MAIL_HOST is required when NODE_ENV is production",
      });
    }
    for (const key of ["EMQX_API_URL", "EMQX_API_PASSWORD"] as const) {
      if (env.NODE_ENV === "production" && env[key] === undefined) {
        ctx.addIssue({ code: "custom", path: [key], message: `${key} is required when NODE_ENV is production` });
      }
    }
    // One secret under two kinds of token lets either pass where the other is asked for (KEHOACH 7.2).
    for (const [at, key] of JWT_SECRETS.entries()) {
      if (JWT_SECRETS.slice(0, at).some((other) => env[other] === env[key])) {
        ctx.addIssue({ code: "custom", path: [key], message: `${key} must differ from the other JWT secrets` });
      }
    }
  })
  .transform((env) => ({ ...env, API_DOCS_ENABLED: env.API_DOCS_ENABLED ?? env.NODE_ENV !== "production" }));

export type Env = z.infer<typeof envSchema>;

/** Read and check the environment once, at boot.
 *  The default argument is the api's only `process.env` read (KEHOACH 4.9).
 */
export function validateEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) {
    return parsed.data;
  }
  const faults = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  throw new Error(`environment is not usable:\n${faults}`);
}
