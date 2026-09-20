/**
 * Excel reads a file as the local code page unless this says otherwise, and
 * every Vietnamese name in it turns to mojibake when it does. A file read by
 * a parser rather than by Excel must not carry it.
 */
export const BYTE_ORDER_MARK = "﻿";

function cell(value: string): string {
  // A name with a comma or a quote in it has broken more payment files than
  // any other single thing, so every cell is quoted and quotes are doubled.
  return `"${value.replace(/"/g, '""')}"`;
}

/** Rows joined the way every reader of a csv expects, and no byte order mark. */
export function toCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
}

/** The same file, marked for Excel. */
export function toExcelCsv(header: string[], rows: string[][]): string {
  return BYTE_ORDER_MARK + toCsv(header, rows);
}
