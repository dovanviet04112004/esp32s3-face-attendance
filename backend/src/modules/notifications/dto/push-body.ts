import { NoticeKind } from "@prisma/client";
import { z } from "zod";

/** What a push carries to a lock screen: a reference and a count, never a name or an amount (KEHOACH 9.21.4). */
export const pushBody = z
  .object({
    v: z.literal(2),
    id: z.uuid(),
    kind: z.enum(NoticeKind),
    category: z.enum(["REQUESTS", "PAY", "PEOPLE", "ATTENDANCE", "SYSTEM"]),
    count: z.number().int().positive(),
    locale: z.enum(["vi", "en"]),
    tag: z.string().min(1).max(200),
    renotify: z.boolean(),
  })
  .strict();

export type PushBody = z.infer<typeof pushBody>;
