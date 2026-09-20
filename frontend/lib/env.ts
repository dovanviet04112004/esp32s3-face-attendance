import { z } from "zod";

const schema = z.object({
  NEXT_PUBLIC_API_URL: z.string().min(1),
  NEXT_PUBLIC_WS_URL: z.string().min(1),
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: z
    .string()
    .optional()
    .transform((held) => (held ? held : undefined)),
});

export type Env = z.infer<typeof schema>;

/** The only `process.env` read in the frontend (KEHOACH 4.9). Next inlines
 *  NEXT_PUBLIC_ names at build time, so each is named in full. An empty VAPID
 *  key turns push off; the bell in the app still works.
 */
export const env: Env = schema.parse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL,
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
});
