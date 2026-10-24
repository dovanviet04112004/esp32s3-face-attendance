import { NoticeKind } from "@prisma/client";
import { z } from "zod";

// An item key or a news dedupKey: kebab words, ids and days joined by ':', with no room for a name (KEHOACH 9.21.4).
const TAG = /^[A-Za-z0-9_:-]{1,128}$/;

/** What a push carries to a lock screen: a reference and a count, never a name or an amount; no id for a rowless kind (KEHOACH 9.21.4). */
export const pushBody = z
  .object({
    v: z.literal(2),
    id: z.union([z.uuid(), z.literal("")]),
    kind: z.enum(NoticeKind),
    category: z.enum(["REQUESTS", "PAY", "PEOPLE", "ATTENDANCE", "SYSTEM"]),
    count: z.number().int().positive(),
    locale: z.enum(["vi", "en"]),
    tag: z.string().regex(TAG),
    renotify: z.boolean(),
    gathered: z.enum(["work", "news", "mixed"]).optional(),
  })
  .strict();

export type PushBody = z.infer<typeof pushBody>;

export type Gathered = NonNullable<PushBody["gathered"]>;
