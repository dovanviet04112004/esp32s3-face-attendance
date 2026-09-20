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
  "departmentCode",
  "jobTitleCode",
  "managerCode",
  "hireDate",
  "baseSalary",
  "insuranceSalary",
] as const;

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

/** Header first, then one object per line, keyed by the column names. */
export function readRows(text: string): { faults: RowFault[]; rows: ImportRow[] } {
  const grid = parseCsv(text).filter((line) => line.some((cell) => cell.trim() !== ""));
  const faults: RowFault[] = [];
  if (grid.length === 0) {
    return { faults: [{ row: kHeaderRow, column: "", code: "FILE_EMPTY", value: "" }], rows: [] };
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
    return { faults, rows: [] };
  }
  const rows = grid.slice(1).map((line) => {
    const row: ImportRow = {};
    header.forEach((name, at) => {
      const value = (line[at] ?? "").trim();
      if (value !== "") {
        row[name as ImportColumn] = value;
      }
    });
    return row;
  });
  return { faults, rows };
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
