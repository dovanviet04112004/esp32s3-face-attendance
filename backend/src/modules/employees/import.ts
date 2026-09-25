import { isEmail } from "class-validator";

import { FORMULA_LEAD } from "../../common/csv.js";

/** Column names are identifiers, so they stay English (CLAUDE.md 3.1). */
export const IMPORT_COLUMNS = [
  "code",
  "fullName",
  "personalEmail",
  "phone",
  "dateOfBirth",
  "gender",
  "nationalId",
  "taxCode",
  "socialInsuranceNo",
  "legalEntityCode",
  "departmentCode",
  "jobTitleCode",
  "managerCode",
  "hireDate",
  "baseSalary",
  "insuranceSalary",
  "bankAccount",
  "bankName",
] as const;

/** The longest value each text field takes; the dto and the import both read this (CLAUDE.md 4.9). */
export const EMPLOYEE_FIELD_MAX = {
  code: 32,
  fullName: 64,
  personalEmail: 128,
  phone: 20,
  nationalId: 20,
  taxCode: 20,
  socialInsuranceNo: 20,
  bankAccount: 32,
  bankName: 64,
} as const;

/** Thirty thousand rows of fifteen columns sit inside this with room over,
 *  and the same figure bounds the body parser and the dto (CLAUDE.md 4.9).
 */
export const IMPORT_MAX_BYTES = 16_000_000;

export const IMPORT_PATH = "/employees/import";

export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

export type ImportRow = Partial<Record<ImportColumn, string>>;

export interface RowFault {
  row: number;
  column: string;
  code: string;
  value: string;
}

export interface ImportReport {
  applied: boolean;
  rows: number;
  toCreate: number;
  toUpdate: number;
  payKept: number;
  faults: RowFault[];
}

const REQUIRED: ImportColumn[] = ["code", "fullName"];
const DATES: ImportColumn[] = ["dateOfBirth", "hireDate"];
const MONEY: ImportColumn[] = ["baseSalary", "insuranceSalary"];
const GENDERS = new Set(["MALE", "FEMALE"]);
const kIsoDate = /^\d{4}-\d{2}-\d{2}$/;
const kDigits = /^\d+$/;
const kByteOrderMark = 0xfeff;
const kHeaderRow = 1;

/**
 * A field may hold a comma, a quote or a newline, which is the whole reason
 * this is not a split on commas.
 */
export function parseCsv(text: string): string[][] {
  const body = text.charCodeAt(0) === kByteOrderMark ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let at = 0;
  while (at < body.length) {
    const here = body[at] as string;
    if (quoted) {
      if (here === '"' && body[at + 1] === '"') {
        cell += '"';
        at += 2;
      } else if (here === '"') {
        quoted = false;
        at += 1;
      } else {
        cell += here;
        at += 1;
      }
      continue;
    }
    if (here === '"') {
      quoted = true;
      at += 1;
    } else if (here === ",") {
      row.push(cell);
      cell = "";
      at += 1;
    } else if (here === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      at += 1;
    } else if (here === "\r") {
      at += 1;
    } else {
      cell += here;
      at += 1;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Header first, then one object per line, keyed by the column names. The header says which
 *  columns an update may write: a column the file leaves out keeps what the record holds.
 */
export function readRows(text: string): { faults: RowFault[]; rows: ImportRow[]; header: ImportColumn[] } {
  const grid = parseCsv(text).filter((line) => line.some((cell) => cell.trim() !== ""));
  const faults: RowFault[] = [];
  if (grid.length === 0) {
    return { faults: [{ row: kHeaderRow, column: "", code: "FILE_EMPTY", value: "" }], rows: [], header: [] };
  }
  const header = (grid[0] as string[]).map((one) => one.trim());
  const known = new Set<string>(IMPORT_COLUMNS);
  for (const name of header) {
    if (!known.has(name)) {
      faults.push({ row: kHeaderRow, column: name, code: "COLUMN_UNKNOWN", value: name });
    }
  }
  for (const needed of REQUIRED) {
    if (!header.includes(needed)) {
      faults.push({ row: kHeaderRow, column: needed, code: "COLUMN_MISSING", value: "" });
    }
  }
  if (faults.length > 0) {
    return { faults, rows: [], header: [] };
  }
  const rows = grid.slice(1).map((line) => {
    const row: ImportRow = {};
    header.forEach((name, at) => {
      const raw = (line[at] ?? "").trim();
      // An export marks a formula cell with a leading ' (KEHOACH 7.2); it comes off again here.
      const value = raw.startsWith("'") && FORMULA_LEAD.test(raw.slice(1)) ? raw.slice(1) : raw;
      if (value !== "") {
        row[name as ImportColumn] = value;
      }
    });
    return row;
  });
  return { faults, rows, header: header as ImportColumn[] };
}

/**
 * What is wrong with one line on its own, with nothing looked up. The line
 * number counts the header, which is what the person sees in Excel.
 */
export function checkShape(row: ImportRow, at: number): RowFault[] {
  const line = at + kHeaderRow + 1;
  const faults: RowFault[] = [];
  for (const column of REQUIRED) {
    if (!row[column]) {
      faults.push({ row: line, column, code: "VALUE_REQUIRED", value: "" });
    }
  }
  for (const column of DATES) {
    const value = row[column];
    if (value && (!kIsoDate.test(value) || Number.isNaN(Date.parse(value)))) {
      faults.push({ row: line, column, code: "DATE_INVALID", value });
    }
  }
  for (const column of MONEY) {
    const value = row[column];
    if (value && !kDigits.test(value)) {
      faults.push({ row: line, column, code: "MONEY_INVALID", value });
    }
  }
  if (row.gender && !GENDERS.has(row.gender)) {
    faults.push({ row: line, column: "gender", code: "GENDER_INVALID", value: row.gender });
  }
  if (row.personalEmail && !isEmail(row.personalEmail)) {
    faults.push({ row: line, column: "personalEmail", code: "EMAIL_INVALID", value: row.personalEmail });
  }
  for (const [column, most] of Object.entries(EMPLOYEE_FIELD_MAX) as [ImportColumn, number][]) {
    const value = row[column];
    if (value && value.length > most) {
      faults.push({ row: line, column, code: "VALUE_TOO_LONG", value: value.slice(0, most) });
    }
  }
  // Insurance is charged on its own figure, and half a pay record cannot be
  // written: either both sides arrive or neither does.
  if (Boolean(row.baseSalary) !== Boolean(row.insuranceSalary)) {
    faults.push({ row: line, column: "insuranceSalary", code: "SALARY_PAIR_INCOMPLETE", value: "" });
  }
  return faults;
}

/** Two lines claiming the same person is the file disagreeing with itself. */
export function checkRepeats(rows: ImportRow[]): RowFault[] {
  const seenAt = new Map<string, number>();
  const faults: RowFault[] = [];
  rows.forEach((row, at) => {
    const code = row.code;
    if (!code) {
      return;
    }
    const first = seenAt.get(code);
    if (first === undefined) {
      seenAt.set(code, at + kHeaderRow + 1);
    } else {
      faults.push({
        row: at + kHeaderRow + 1,
        column: "code",
        code: "CODE_REPEATED_IN_FILE",
        value: `${code} @${first}`,
      });
    }
  });
  return faults;
}
