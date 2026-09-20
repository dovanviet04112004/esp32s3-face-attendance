import { BadRequestException } from "@nestjs/common";

/** Past this an offset is refused: OFFSET n walks n rows and throws them
 *  away, so a deep page takes the cursor (KEHOACH 9.9 rule 3). */
export const MAX_OFFSET = 10_000;

export interface CursorKey {
  sortValue: string;
  id: string;
}

export function encodeCursor(sortValue: Date | string, id: number | bigint | string): string {
  const held = sortValue instanceof Date ? sortValue.toISOString() : sortValue;
  return Buffer.from(JSON.stringify({ sortValue: held, id: String(id) })).toString("base64url");
}

export function decodeCursor(raw: string): CursorKey {
  let read: unknown;
  try {
    read = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new BadRequestException("CURSOR_INVALID");
  }
  const key = read as Partial<CursorKey>;
  if (typeof key?.sortValue !== "string" || typeof key?.id !== "string") {
    throw new BadRequestException("CURSOR_INVALID");
  }
  return { sortValue: key.sortValue, id: key.id };
}

export function nextCursor<T extends { id: number | bigint | string }>(
  rows: T[],
  take: number,
  sortValueOf: (row: T) => Date | string,
): string | null {
  const last = rows[rows.length - 1];
  return rows.length === take && last ? encodeCursor(sortValueOf(last), last.id) : null;
}
