/** Marks a file UTF-8 for Excel, which otherwise reads the local code page and garbles every Vietnamese name; a parser must not get it. */
export const BYTE_ORDER_MARK = "\ufeff";

export const EXPORT_MAX_ROWS = 50_000;

/** A cell opening with = + - @ tab or CR, which Excel runs as a formula (KEHOACH 7.2). */
export const FORMULA_LEAD = /^[=+\-@\t\r]/;

function cell(value: string): string {
  // Every cell is quoted: a comma or a quote in a name breaks payment files more than anything else.
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
