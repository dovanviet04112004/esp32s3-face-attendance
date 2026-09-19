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

  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),

  CORS_ORIGIN: z.string().min(1),

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
