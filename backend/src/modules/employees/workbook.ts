import { Readable, PassThrough } from "node:stream";
import { crc32, inflateRawSync } from "node:zlib";

import { BadRequestException, HttpException, PayloadTooLargeException } from "@nestjs/common";
import ExcelJS from "exceljs";

import { IMPORT_COLUMNS, IMPORT_MAX_ROWS, type SheetLine } from "./import.js";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Sheet names are identifiers the importer looks for, so they stay English (CLAUDE.md 3.1). */
export const PEOPLE_SHEET = "employees";
export const CATALOGUE_SHEET = "catalogues";

/** Thirty thousand full rows inflate to 36 MB; this leaves room over and stops a bomb (KEHOACH 9.20 rule 1). */
export const IMPORT_MAX_INFLATED_BYTES = 128_000_000;

/** Every row of the largest import in every column, and room over for the catalogues sheet. */
export const IMPORT_MAX_CELLS = (IMPORT_MAX_ROWS + 1) * IMPORT_COLUMNS.length * 2;

// PKWARE APPNOTE 4.3: end of central directory, central file header, local file header, data descriptor.
const kEndOfDirectory = 0x06054b50;
const kDirectoryEntry = 0x02014b50;
const kLocalEntry = 0x04034b50;
const kDescriptor = 0x08074b50;
const kEndFixed = 22;
const kDirectoryFixed = 46;
const kLocalFixed = 30;
const kCommentMax = 0xffff;
const kZip64 = 0xffffffff;
const kFlagEncrypted = 0x1;
const kFlagDescriptor = 0x8;
const kFlagUtf8Name = 0x800;
const kZipVersion = 20;
const kStored = 0;
const kDeflated = 8;
const kMaxEntries = 1_000;
const kWorksheet = /^xl\/worksheets\/sheet\d+\.xml$/;
const kRowOpen = [Buffer.from("<row "), Buffer.from("<row>")];
const kCellOpen = [Buffer.from("<c "), Buffer.from("<c>")];
// What the stream reader needs, in the order that lets it parse each sheet as it arrives.
const READ_FIRST = ["xl/_rels/workbook.xml.rels", "xl/workbook.xml", "xl/styles.xml", "xl/sharedStrings.xml"];
const EMPTY_STRINGS = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>',
);
const kReadSliceBytes = 65_536;
const kDefaultWidth = 16;
const WIDTHS: Readonly<Record<string, number>> = {
  fullName: 28,
  personalEmail: 30,
  legalEntityCode: 24,
  departmentCode: 32,
  jobTitleCode: 28,
  bankName: 26,
  shiftName: 26,
  kioskId: 28,
};
const kCatalogueWidth = 40;

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  packed: number;
  size: number;
  offset: number;
}

export interface XlsxPart {
  name: string;
  body: Buffer;
}

function unreadable(): never {
  throw new BadRequestException("IMPORT_FILE_UNREADABLE");
}

function directoryOf(zip: Buffer): { entries: ZipEntry[]; directoryAt: number } {
  const floor = Math.max(0, zip.length - kEndFixed - kCommentMax);
  let end = zip.length - kEndFixed;
  while (end >= floor && zip.readUInt32LE(end) !== kEndOfDirectory) {
    end -= 1;
  }
  if (end < floor) {
    unreadable();
  }
  const count = zip.readUInt16LE(end + 10);
  const directoryAt = zip.readUInt32LE(end + 16);
  if (count === 0 || count > kMaxEntries || directoryAt === kZip64) {
    unreadable();
  }
  let at = directoryAt;
  const entries: ZipEntry[] = [];
  for (let seen = 0; seen < count; seen += 1) {
    if (at + kDirectoryFixed > zip.length || zip.readUInt32LE(at) !== kDirectoryEntry) {
      unreadable();
    }
    const nameLength = zip.readUInt16LE(at + 28);
    entries.push({
      name: zip.toString("utf8", at + kDirectoryFixed, at + kDirectoryFixed + nameLength),
      flags: zip.readUInt16LE(at + 8),
      method: zip.readUInt16LE(at + 10),
      packed: zip.readUInt32LE(at + 20),
      size: zip.readUInt32LE(at + 24),
      offset: zip.readUInt32LE(at + 42),
    });
    at += kDirectoryFixed + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return { entries, directoryAt };
}

// Where the entry's data starts and where the next header must start, read off its local header.
function spanOf(zip: Buffer, entry: ZipEntry): { from: number; to: number } {
  if (entry.offset + kLocalFixed > zip.length || zip.readUInt32LE(entry.offset) !== kLocalEntry) {
    unreadable();
  }
  const from = entry.offset + kLocalFixed + zip.readUInt16LE(entry.offset + 26) + zip.readUInt16LE(entry.offset + 28);
  let to = from + entry.packed;
  if (entry.flags & kFlagDescriptor) {
    to += to + 4 <= zip.length && zip.readUInt32LE(to) === kDescriptor ? 16 : 12;
  }
  return { from, to };
}

function countOf(xml: Buffer, marks: readonly Buffer[]): number {
  let found = 0;
  for (const mark of marks) {
    for (let at = xml.indexOf(mark); at >= 0; at = xml.indexOf(mark, at + mark.length)) {
      found += 1;
    }
  }
  return found;
}

function inflated(packed: Buffer, entry: ZipEntry, budget: number): Buffer {
  if (entry.method === kStored) {
    return packed;
  }
  if (entry.method !== kDeflated) {
    unreadable();
  }
  try {
    return inflateRawSync(packed, { maxOutputLength: budget + 1 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new PayloadTooLargeException("IMPORT_FILE_TOO_LARGE");
    }
    unreadable();
  }
}

function walk(zip: Buffer): XlsxPart[] {
  const { entries, directoryAt } = directoryOf(zip);
  const parts: XlsxPart[] = [];
  let budget = IMPORT_MAX_INFLATED_BYTES;
  let cells = 0;
  let next = 0;
  for (const entry of entries.sort((a, b) => a.offset - b.offset)) {
    if (entry.offset !== next || entry.flags & kFlagEncrypted || entry.packed === kZip64 || entry.size === kZip64) {
      unreadable();
    }
    const span = spanOf(zip, entry);
    next = span.to;
    const body = inflated(zip.subarray(span.from, span.from + entry.packed), entry, budget);
    budget -= body.length;
    if (budget < 0) {
      throw new PayloadTooLargeException("IMPORT_FILE_TOO_LARGE");
    }
    if (body.length !== entry.size) {
      unreadable();
    }
    if (kWorksheet.test(entry.name)) {
      cells += countOf(body, kCellOpen);
      if (countOf(body, kRowOpen) > IMPORT_MAX_ROWS + 1) {
        throw new PayloadTooLargeException("IMPORT_TOO_MANY_ROWS");
      }
      if (cells > IMPORT_MAX_CELLS) {
        throw new PayloadTooLargeException("IMPORT_FILE_TOO_LARGE");
      }
    }
    parts.push({ name: entry.name, body });
  }
  if (next !== directoryAt) {
    unreadable();
  }
  return parts;
}

/**
 * Inflate every part under one budget and count the rows and cells of every
 * sheet, so a file is refused on what it holds, not on the sizes it claims. The
 * parts must lie back to back, or a local header could hide one the directory never lists.
 */
export function inspectXlsx(zip: Buffer): XlsxPart[] {
  try {
    return walk(zip);
  } catch (error) {
    if (error instanceof HttpException) {
      throw error;
    }
    unreadable();
  }
}

// exceljs 4.4 decodes each stream chunk on its own and garbles a letter split across two; ASCII cannot split.
function asciiOf(xml: Buffer): Buffer {
  const text = xml.toString("utf8").replace(/^﻿/, "");
  return Buffer.from(text.replace(/[^\x00-\x7f]/gu, (one) => `&#${one.codePointAt(0)};`), "utf8");
}

function storedEntry(name: Buffer, body: Buffer, offset: number): { local: Buffer; central: Buffer } {
  const sum = crc32(body);
  const local = Buffer.alloc(kLocalFixed);
  local.writeUInt32LE(kLocalEntry, 0);
  local.writeUInt16LE(kZipVersion, 4);
  local.writeUInt16LE(kFlagUtf8Name, 6);
  local.writeUInt16LE(kStored, 8);
  local.writeUInt32LE(sum, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(kDirectoryFixed);
  central.writeUInt32LE(kDirectoryEntry, 0);
  central.writeUInt16LE(kZipVersion, 4);
  central.writeUInt16LE(kZipVersion, 6);
  central.writeUInt16LE(kFlagUtf8Name, 8);
  central.writeUInt16LE(kStored, 10);
  central.writeUInt32LE(sum, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  return { local, central };
}

/** The parts the stream reader reads, as ASCII and uncompressed, shared strings ahead of the sheets. */
function repack(parts: readonly XlsxPart[]): Buffer {
  const byName = new Map(parts.map((one) => [one.name, one.body]));
  byName.set("xl/sharedStrings.xml", byName.get("xl/sharedStrings.xml") ?? EMPTY_STRINGS);
  const sheets = parts.filter((one) => kWorksheet.test(one.name)).map((one) => one.name);
  const order = [...READ_FIRST.filter((name) => byName.has(name)), ...sheets];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of order) {
    const body = asciiOf(byName.get(name) as Buffer);
    const label = Buffer.from(name, "utf8");
    const entry = storedEntry(label, body, offset);
    locals.push(entry.local, label, body);
    centrals.push(entry.central, label);
    offset += kLocalFixed + label.length + body.length;
  }
  const end = Buffer.alloc(kEndFixed);
  end.writeUInt32LE(kEndOfDirectory, 0);
  end.writeUInt16LE(order.length, 8);
  end.writeUInt16LE(order.length, 10);
  end.writeUInt32LE(centrals.reduce((sum, one) => sum + one.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** A cell as the csv reader would have handed it over: a date as its day, a number as its digits. */
function textOf(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "boolean") {
    return value ? "YES" : "NO";
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if ("richText" in value) {
    return value.richText.map((one) => one.text).join("");
  }
  if ("result" in value) {
    return textOf((value.result ?? null) as ExcelJS.CellValue);
  }
  if ("text" in value && typeof value.text === "string") {
    return value.text;
  }
  return "";
}

// The reader holds every parse event of one chunk at once, so a whole sheet in one chunk is the whole sheet in memory.
function* slicesOf(zip: Buffer): Generator<Buffer> {
  for (let at = 0; at < zip.length; at += kReadSliceBytes) {
    yield zip.subarray(at, at + kReadSliceBytes);
  }
}

/** The people sheet, or the first one when none carries that name, line by line as text. */
export async function readWorkbook(zip: Buffer): Promise<SheetLine[]> {
  const readable = repack(inspectXlsx(zip));
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from(slicesOf(readable)), {
    sharedStrings: "cache",
    styles: "cache",
    hyperlinks: "ignore",
    worksheets: "emit",
    entries: "ignore",
  });
  const sheets: { name: string; lines: SheetLine[] }[] = [];
  try {
    for await (const sheet of reader) {
      const lines: SheetLine[] = [];
      for await (const row of sheet) {
        const values = row.values as ExcelJS.CellValue[];
        lines.push({ line: row.number, cells: Array.from(values.slice(1), (one) => textOf(one ?? null)) });
      }
      sheets.push({ name: (sheet as unknown as { name?: string }).name ?? "", lines });
    }
  } catch {
    unreadable();
  }
  const people = sheets.find((one) => one.name === PEOPLE_SHEET) ?? sheets[0];
  return people?.lines ?? [];
}

// exceljs 4.4 writes a sheet's validations but leaves the property out of its typings.
type Validated = { dataValidations: { add(range: string, rule: ExcelJS.DataValidation): void } };

export interface WorkbookInput {
  header: readonly string[];
  rows: readonly string[][];
  lists: ReadonlyMap<string, readonly string[]>;
}

function letterOf(column: number): string {
  let letters = "";
  for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  }
  return letters;
}

/**
 * The people sheet with the import's own header, every cell a string so none
 * runs as a formula (KEHOACH 7.2), and a drop-down on each catalogue column
 * pointing into the catalogues sheet for as many rows as one import takes.
 */
export async function writeWorkbook(input: WorkbookInput): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    out.on("end", resolve);
    out.on("error", reject);
  });
  const book = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: true });
  const people = book.addWorksheet(PEOPLE_SHEET, { views: [{ state: "frozen", ySplit: 1 }] });
  people.columns = input.header.map((key) => ({ key, width: WIDTHS[key] ?? kDefaultWidth, style: { numFmt: "@" } }));
  const head = people.addRow([...input.header]);
  head.font = { bold: true };
  head.commit();
  for (const row of input.rows) {
    people.addRow(row).commit();
  }
  const listed = [...input.lists.entries()].filter(([, entries]) => entries.length > 0);
  listed.forEach(([key, entries], at) => {
    const column = input.header.indexOf(key) + 1;
    if (column === 0) {
      return;
    }
    const source = letterOf(at + 1);
    // Typing a bare code stays allowed, so the list offers without refusing.
    (people as unknown as Validated).dataValidations.add(`${letterOf(column)}2:${letterOf(column)}${IMPORT_MAX_ROWS + 1}`, {
      type: "list",
      allowBlank: true,
      showErrorMessage: false,
      formulae: [`${CATALOGUE_SHEET}!$${source}$2:$${source}$${entries.length + 1}`],
    });
  });
  people.commit();
  const catalogues = book.addWorksheet(CATALOGUE_SHEET, { views: [{ state: "frozen", ySplit: 1 }] });
  catalogues.columns = listed.map(([key]) => ({ key, width: kCatalogueWidth, style: { numFmt: "@" } }));
  const names = catalogues.addRow(listed.map(([key]) => key));
  names.font = { bold: true };
  names.commit();
  const depth = Math.max(0, ...listed.map(([, entries]) => entries.length));
  for (let at = 0; at < depth; at += 1) {
    catalogues.addRow(listed.map(([, entries]) => entries[at] ?? null)).commit();
  }
  catalogues.commit();
  await book.commit();
  await done;
  return Buffer.concat(chunks);
}
