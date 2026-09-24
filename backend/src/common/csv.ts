/** Marks a file UTF-8 for Excel, which otherwise reads the local code page and garbles every Vietnamese name; a parser must not get it. */
export const BYTE_ORDER_MARK = "\ufeff";

/** A cell opening with = + - @ tab or CR, which Excel runs as a formula (KEHOACH 7.2). */
export const FORMULA_LEAD = /^[=+\-@\t\r]/;

function cell(value: string): string {
  // A name with a comma or a quote in it has broken more payment files than
  // any other single thing, so every cell is quoted and quotes are doubled.
  return `"${value.replace(/"/g, '""')}"`;
}

/** Rows joined the way every reader of a csv expects, and no byte order mark. */
export function toCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
}

/** The same file, marked for Excel; a formula cell but a plain number gets a leading ' Excel shows as text. */
export function toExcelCsv(header: string[], rows: string[][]): string {
  const inert = (value: string) => (FORMULA_LEAD.test(value) && !/^-?\d+(\.\d+)?$/.test(value) ? `'${value}` : value);
  return BYTE_ORDER_MARK + toCsv(header.map(inert), rows.map((row) => row.map(inert)));
}
