import { BadRequestException } from "@nestjs/common";

/** Past this an offset is refused: OFFSET n walks n rows and throws them
 *  away, so a deep page takes the cursor (KEHOACH 9.9 rule 3). */
export const MAX_OFFSET = 10_000;

/** A total above the offset ceiling names pages that ceiling already refuses,
 *  so counting stops there and says so (KEHOACH 9.9 rule 6). */
export const COUNT_CEILING = MAX_OFFSET;

export function countedTo(found: number): { total: number; totalIsExact: boolean } {
  return found > COUNT_CEILING
    ? { total: COUNT_CEILING, totalIsExact: false }
    : { total: found, totalIsExact: true };
}

export interface CursorKey<Id = string> {
  sortValue: string;
  id: Id;
}

type IdColumn = "text" | "int" | "bigint";

const COLUMN_MAX = { int: 2_147_483_647n, bigint: 9_223_372_036_854_775_807n } as const;

export function encodeCursor(sortValue: Date | string, id: number | bigint | string): string {
  const held = sortValue instanceof Date ? sortValue.toISOString() : sortValue;
  return Buffer.from(JSON.stringify({ sortValue: held, id: String(id) })).toString("base64url");
}

/** The key a cursor resumes after, its id read as the id column holds it; anything else is CURSOR_INVALID. */
export function decodeCursor(raw: string, id?: "text"): CursorKey;
export function decodeCursor(raw: string, id: "int"): CursorKey<number>;
export function decodeCursor(raw: string, id: "bigint"): CursorKey<bigint>;
export function decodeCursor(raw: string, id: IdColumn): CursorKey<string | number | bigint>;
export function decodeCursor(raw: string, id: IdColumn = "text"): CursorKey<string | number | bigint> {
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
  if (id === "text") {
    return { sortValue: key.sortValue, id: key.id };
  }
  if (!/^\d+$/.test(key.id) || BigInt(key.id) > COLUMN_MAX[id]) {
    throw new BadRequestException("CURSOR_INVALID");
  }
  return { sortValue: key.sortValue, id: id === "int" ? Number(key.id) : BigInt(key.id) };
}

/** Rows past the cursor in `(field, key)` order; `field` holds a time unless `sort` says it holds text. */
export function resumeAfter(
  field: string,
  order: "asc" | "desc",
  cursor: string | undefined,
  { sort = "time", id = "text", key: idField = "id" }: { sort?: "time" | "text"; id?: IdColumn; key?: string } = {},
): Record<string, unknown> {
  if (!cursor) {
    return {};
  }
  const key = decodeCursor(cursor, id);
  const at = sort === "time" ? new Date(key.sortValue) : key.sortValue;
  if (at instanceof Date && Number.isNaN(at.getTime())) {
    throw new BadRequestException("CURSOR_INVALID");
  }
  const past = order === "asc" ? "gt" : "lt";
  return {
    AND: [
      // Looks redundant; it is the bound Postgres turns into an index condition (KEHOACH 9.9 rule 3).
      { [field]: { [order === "asc" ? "gte" : "lte"]: at } },
      { OR: [{ [field]: { [past]: at } }, { [field]: at, [idField]: { [past]: key.id } }] },
    ],
  };
}

export function nextCursor<T extends { id: number | bigint | string }>(
  rows: T[],
  take: number,
  sortValueOf: (row: T) => Date | string,
): string | null {
  const last = rows[rows.length - 1];
  return rows.length === take && last ? encodeCursor(sortValueOf(last), last.id) : null;
}
