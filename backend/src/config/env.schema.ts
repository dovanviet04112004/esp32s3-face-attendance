import { z } from "zod";

export const envSchema = z.object({
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
  JWT_DEVICE_SECRET: z.string().min(32),

  LOGIN_ATTEMPTS_PER_MINUTE: z.coerce.number().int().positive().default(5),
  SESSIONS_PER_USER: z.coerce.number().int().positive().default(10),
  DEVICE_REGISTER_ATTEMPTS_PER_MINUTE: z.coerce.number().int().positive().default(12),

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

  MQTT_URL: z.string().min(1),
  MQTT_USERNAME: z.string().min(1),
  MQTT_PASSWORD: z.string().min(1),
  MQTT_CA_CERT_PATH: z.string().optional(),
});

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
