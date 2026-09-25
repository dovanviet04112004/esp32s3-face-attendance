import { Gender, type EnrollmentState } from "@prisma/client";
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
  "shiftName",
  "shiftFrom",
  "consentPaper",
  "kioskId",
  "openLogin",
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

/** People one file may carry; a longer file is refused unread (KEHOACH 9.20 rule 1). */
export const IMPORT_MAX_ROWS = 30_000;

export const IMPORT_PATH = "/employees/import";

/** Between the code and the name of a drop-down entry; the import keeps the part ahead of it (KEHOACH 9.20 rule 2). */
export const ENTRY_SEPARATOR = " · ";

/** A cell holding only this empties the field for someone already here; an empty cell keeps it (KEHOACH 9.20 rule 4). */
export const CLEAR = "-";

/** People the dry run spells out field by field; the rest are counted. */
export const CHANGES_LISTED = 100;

export const GENDERS: readonly string[] = Object.values(Gender);

/** The two values openLogin and consentPaper take; an empty cell reads as NO. */
export const FLAGS = ["YES", "NO"] as const;

export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

export type ImportRow = Partial<Record<ImportColumn, string>>;

export interface RowFault {
  row: number;
  column: string;
  code: string;
  value: string;
}

/** What Apply does to one person already here: columns given a new value, and columns emptied. */
export interface ChangeLine {
  row: number;
  code: string;
  fields: ImportColumn[];
  cleared: ImportColumn[];
}

export interface ImportReport {
  applied: boolean;
  rows: number;
  toCreate: number;
  toUpdate: number;
  unchanged: number;
  payKept: number;
  shiftsToAssign: number;
  consentsToRecord: number;
  kiosksToAssign: number;
  loginsToOpen: number;
  changes: ChangeLine[];
  faults: RowFault[];
  warnings: RowFault[];
}

/** The file as it arrived: xlsx bytes, or csv text. */
export type ImportUpload = { kind: "xlsx"; bytes: Buffer } | { kind: "csv"; text: string };

/** One line of a sheet: the number a person sees beside it, and its cells as text. */
export interface SheetLine {
  line: number;
  cells: string[];
}

export interface ReadRows {
  faults: RowFault[];
  rows: ImportRow[];
  lines: number[];
  header: ImportColumn[];
}

const DATES: ImportColumn[] = ["dateOfBirth", "hireDate", "shiftFrom"];
const MONEY: ImportColumn[] = ["baseSalary", "insuranceSalary"];
const YES_NO: ImportColumn[] = ["consentPaper", "openLogin"];
// Compared and written as they stand; the catalogue and manager columns go through their lookups.
const PLAIN = ["fullName", "phone", "dateOfBirth", "gender", "nationalId", "taxCode", "socialInsuranceNo", "hireDate"] as const;
// Held back for someone already here: they move only through a request (KEHOACH 9.17 rules 1 and 3).
export const BY_REQUEST = ["personalEmail", "bankAccount", "bankName"] as const;
// What a "-" may empty; everything else has its own way back (KEHOACH 9.20 rule 4).
const CLEARABLE: ReadonlySet<ImportColumn> = new Set([
  "phone",
  "dateOfBirth",
  "gender",
  "nationalId",
  "taxCode",
  "socialInsuranceNo",
  "hireDate",
  "departmentCode",
  "jobTitleCode",
  "managerCode",
] as ImportColumn[]);
// What the Employee row itself holds; the rest rides on other tables.
const RECORD: ReadonlySet<ImportColumn> = new Set([
  ...PLAIN,
  "legalEntityCode",
  "departmentCode",
  "jobTitleCode",
] as ImportColumn[]);
const EXTRAS: ReadonlySet<ImportColumn> = new Set([
  "shiftName",
  "shiftFrom",
  "consentPaper",
  "kioskId",
  "openLogin",
] as ImportColumn[]);
const kIsoDate = /^\d{4}-\d{2}-\d{2}$/;
const kDigits = /^\d+$/;
const kByteOrderMark = 0xfeff;

export type HeldColumn = (typeof PLAIN)[number] | (typeof BY_REQUEST)[number];

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

/** A csv record is one row in Excel, so its place in the file is the line people are told. */
export function csvLines(text: string): SheetLine[] {
  return parseCsv(text).map((cells, at) => ({ line: at + 1, cells }));
}

/** Header first, then one object per line, keyed by the column names. A column the file leaves
 *  out, like a cell it leaves empty, keeps what the record holds.
 */
export function readLines(sheet: SheetLine[]): ReadRows {
  const filled = sheet.filter((one) => one.cells.some((cell) => cell.trim() !== ""));
  const faults: RowFault[] = [];
  const top = filled[0];
  if (!top) {
    return { faults: [{ row: 1, column: "", code: "FILE_EMPTY", value: "" }], rows: [], lines: [], header: [] };
  }
  const header = top.cells.map((one) => one.trim());
  const known = new Set<string>(IMPORT_COLUMNS);
  for (const name of header) {
    if (!known.has(name)) {
      faults.push({ row: top.line, column: name, code: "COLUMN_UNKNOWN", value: name });
    }
  }
  if (!header.includes("code")) {
    faults.push({ row: top.line, column: "code", code: "COLUMN_MISSING", value: "" });
  }
  if (faults.length > 0) {
    return { faults, rows: [], lines: [], header: [] };
  }
  const body = filled.slice(1);
  const rows = body.map(({ cells }) => {
    const row: ImportRow = {};
    header.forEach((name, at) => {
      const raw = (cells[at] ?? "").trim();
      // An export marks a formula cell with a leading ' (KEHOACH 7.2); it comes off again here.
      const value = raw.startsWith("'") && FORMULA_LEAD.test(raw.slice(1)) ? raw.slice(1) : raw;
      if (value !== "") {
        row[name as ImportColumn] = value;
      }
    });
    return row;
  });
  return { faults, rows, lines: body.map((one) => one.line), header: header as ImportColumn[] };
}

export function readRows(text: string): ReadRows {
  return readLines(csvLines(text));
}

/** What is wrong with one line on its own, with nothing looked up; a "-" is judged once the person is known. */
export function checkShape(row: ImportRow, line: number): RowFault[] {
  const faults: RowFault[] = [];
  const valueOf = (column: ImportColumn) => (row[column] === CLEAR ? undefined : row[column]);
  if (!valueOf("code")) {
    faults.push({ row: line, column: "code", code: "VALUE_REQUIRED", value: "" });
  }
  for (const column of DATES) {
    const value = valueOf(column);
    if (value && (!kIsoDate.test(value) || Number.isNaN(Date.parse(value)))) {
      faults.push({ row: line, column, code: "DATE_INVALID", value });
    }
  }
  for (const column of MONEY) {
    const value = valueOf(column);
    if (value && !kDigits.test(value)) {
      faults.push({ row: line, column, code: "MONEY_INVALID", value });
    }
  }
  const gender = valueOf("gender");
  if (gender && !GENDERS.includes(gender)) {
    faults.push({ row: line, column: "gender", code: "GENDER_INVALID", value: gender });
  }
  for (const column of YES_NO) {
    const value = valueOf(column);
    if (value && !(FLAGS as readonly string[]).includes(value)) {
      faults.push({ row: line, column, code: "FLAG_INVALID", value });
    }
  }
  const email = valueOf("personalEmail");
  if (email && !isEmail(email)) {
    faults.push({ row: line, column: "personalEmail", code: "EMAIL_INVALID", value: email });
  }
  for (const [column, most] of Object.entries(EMPLOYEE_FIELD_MAX) as [ImportColumn, number][]) {
    const value = valueOf(column);
    if (value && value.length > most) {
      faults.push({ row: line, column, code: "VALUE_TOO_LONG", value: value.slice(0, most) });
    }
  }
  // Insurance is charged on its own figure, and half a pay record cannot be
  // written: either both sides arrive or neither does.
  if (Boolean(valueOf("baseSalary")) !== Boolean(valueOf("insuranceSalary"))) {
    faults.push({ row: line, column: "insuranceSalary", code: "SALARY_PAIR_INCOMPLETE", value: "" });
  }
  if (valueOf("shiftFrom") && !valueOf("shiftName")) {
    faults.push({ row: line, column: "shiftName", code: "VALUE_REQUIRED", value: "" });
  }
  return faults;
}

/** Two lines claiming the same person is the file disagreeing with itself. */
export function checkRepeats(rows: ImportRow[], lines: number[]): RowFault[] {
  const seenAt = new Map<string, number>();
  const faults: RowFault[] = [];
  rows.forEach((row, at) => {
    const code = row.code;
    const line = lines[at] ?? 0;
    if (!code) {
      return;
    }
    const first = seenAt.get(code);
    if (first === undefined) {
      seenAt.set(code, line);
    } else {
      faults.push({ row: line, column: "code", code: "CODE_REPEATED_IN_FILE", value: `${code} @${first}` });
    }
  });
  return faults;
}

/** A catalogue entry as the import finds it; a retired one still matches what someone already holds. */
export interface Entry {
  id: string;
  active: boolean;
}

export interface Catalogue {
  entities: ReadonlyMap<string, Entry>;
  onlyEntity: string | null;
  departments: ReadonlyMap<string, Entry>;
  departmentCodes: ReadonlySet<string>;
  entityOfDepartment: ReadonlyMap<string, string>;
  titles: ReadonlyMap<string, Entry>;
  shifts: ReadonlyMap<string, Entry>;
  approvedKiosks: ReadonlySet<string>;
}

/** What the database holds for someone the file names; `values` reads as the export writes it. */
export interface Held {
  id: number;
  active: boolean;
  locale: string;
  values: Record<HeldColumn, string>;
  legalEntityId: string | null;
  departmentId: string | null;
  jobTitleId: string | null;
  managerCode: string;
  hasPay: boolean;
  hasLogin: boolean;
  consented: boolean;
  shifts: ReadonlySet<string>;
  kiosks: ReadonlyMap<string, EnrollmentState>;
}

export interface Placement {
  legalEntityId: string | null;
  departmentId: string | null;
  jobTitleId: string | null;
}

/** What one line does once its faults are gone; `fields` and `cleared` name columns, never values (KEHOACH 9.24 rule 4). */
export interface RowPlan {
  line: number;
  row: ImportRow;
  held: Held | undefined;
  place: Placement;
  fields: ImportColumn[];
  cleared: ImportColumn[];
  writesRecord: boolean;
  shift: { shiftId: string; validFrom: string } | null;
  consent: boolean;
  kiosk: string | null;
  login: boolean;
}

export interface PlanInput {
  read: ReadRows;
  catalogue: Catalogue;
  heldBy: ReadonlyMap<string, Held>;
  managers: ReadonlySet<string>;
  takenEmails: ReadonlySet<string>;
  today: string;
}

export interface Planned {
  plans: RowPlan[];
  faults: RowFault[];
  warnings: RowFault[];
  payKept: number;
}

/** The code of a drop-down entry, and the entity a department entry names last; a typed code stands as it is. */
export function entryOf(cell: string | undefined, known: ReadonlySet<string>): { code?: string; entity: string | null } {
  if (cell === undefined || known.has(cell)) {
    return { code: cell, entity: null };
  }
  const parts = cell.split(ENTRY_SEPARATOR);
  return { code: parts[0]?.trim() || undefined, entity: parts.length > 2 ? (parts.at(-1)?.trim() ?? null) : null };
}

type Note = (column: ImportColumn, code: string, value?: string) => void;

/** Where one line puts its person; a department code is read inside the line's legal entity (KEHOACH 9.3). */
function placeRow(
  row: ImportRow,
  named: string | null,
  held: Held | undefined,
  keepsDepartment: boolean,
  catalogue: Catalogue,
  fault: Note,
): Placement {
  const namedEntity = named ? (catalogue.entities.get(named)?.id ?? null) : null;
  let legalEntityId = held?.legalEntityId ?? catalogue.onlyEntity;
  if (row.legalEntityCode) {
    const entity = catalogue.entities.get(row.legalEntityCode);
    legalEntityId = entity?.id ?? null;
    if (!entity) {
      fault("legalEntityCode", "LEGAL_ENTITY_UNKNOWN", row.legalEntityCode);
    } else if (!entity.active && entity.id !== held?.legalEntityId) {
      fault("legalEntityCode", "LEGAL_ENTITY_RETIRED", row.legalEntityCode);
    }
  } else if (!legalEntityId && namedEntity) {
    legalEntityId = namedEntity;
  } else if (!legalEntityId && (!held || row.departmentCode)) {
    fault("legalEntityCode", "LEGAL_ENTITY_REQUIRED");
  }
  let departmentId: string | null = null;
  if (row.departmentCode && legalEntityId) {
    const department = catalogue.departments.get(`${legalEntityId}/${row.departmentCode}`);
    departmentId = department?.id ?? null;
    if (namedEntity && namedEntity !== legalEntityId) {
      fault("departmentCode", "DEPARTMENT_ENTITY_MISMATCH", `${row.departmentCode}${ENTRY_SEPARATOR}${named}`);
    } else if (!department) {
      fault("departmentCode", "DEPARTMENT_UNKNOWN", row.departmentCode);
    } else if (!department.active && department.id !== held?.departmentId) {
      fault("departmentCode", "DEPARTMENT_RETIRED", row.departmentCode);
    }
  } else if (
    held?.departmentId &&
    legalEntityId &&
    keepsDepartment &&
    catalogue.entityOfDepartment.get(held.departmentId) !== legalEntityId
  ) {
    fault("legalEntityCode", "DEPARTMENT_OTHER_ENTITY", row.legalEntityCode ?? "");
  }
  let jobTitleId: string | null = null;
  if (row.jobTitleCode) {
    const title = catalogue.titles.get(row.jobTitleCode);
    jobTitleId = title?.id ?? null;
    if (!title) {
      fault("jobTitleCode", "JOB_TITLE_UNKNOWN", row.jobTitleCode);
    } else if (!title.active && title.id !== held?.jobTitleId) {
      fault("jobTitleCode", "JOB_TITLE_RETIRED", row.jobTitleCode);
    }
  }
  return { legalEntityId, departmentId, jobTitleId };
}

/** The columns a line gives a new value for someone already here; an empty cell gives none. */
function changesOf(row: ImportRow, place: Placement, held: Held): ImportColumn[] {
  const changed: ImportColumn[] = PLAIN.filter((column) => row[column] !== undefined && row[column] !== held.values[column]);
  const moved: [ImportColumn, boolean][] = [
    ["legalEntityCode", place.legalEntityId !== held.legalEntityId],
    ["departmentCode", place.departmentId !== held.departmentId],
    ["jobTitleCode", place.jobTitleId !== held.jobTitleId],
    ["managerCode", row.managerCode !== held.managerCode],
  ];
  changed.push(...moved.filter(([column, differs]) => row[column] !== undefined && differs).map(([column]) => column));
  if (row.baseSalary && row.insuranceSalary && !held.hasPay) {
    changed.push("baseSalary", "insuranceSalary");
  }
  return changed;
}

function holds(held: Held, column: ImportColumn): boolean {
  switch (column) {
    case "departmentCode":
      return held.departmentId !== null;
    case "jobTitleCode":
      return held.jobTitleId !== null;
    case "managerCode":
      return held.managerCode !== "";
    default:
      return held.values[column as HeldColumn] !== "";
  }
}

/** The "-" cells of someone already here: the fields they empty, and a fault or a warning for the rest. */
function clearsOf(raw: ImportRow, held: Held, fault: Note, warn: Note): ImportColumn[] {
  const cleared: ImportColumn[] = [];
  for (const column of IMPORT_COLUMNS.filter((one) => raw[one] === CLEAR)) {
    if (CLEARABLE.has(column)) {
      cleared.push(...(holds(held, column) ? [column] : []));
    } else if ((BY_REQUEST as readonly string[]).includes(column)) {
      if (holds(held, column)) {
        warn(column, "CHANGE_BY_REQUEST", CLEAR);
      }
    } else {
      fault(column, "CLEAR_NOT_ALLOWED", CLEAR);
    }
  }
  return cleared;
}

function planShift(row: ImportRow, held: Held | undefined, input: PlanInput, fault: Note, warn: Note): RowPlan["shift"] {
  if (!row.shiftName) {
    return null;
  }
  const shift = input.catalogue.shifts.get(row.shiftName);
  if (!shift) {
    fault("shiftName", "SHIFT_UNKNOWN", row.shiftName);
    return null;
  }
  const validFrom = row.shiftFrom ?? row.hireDate ?? (held?.values.hireDate || input.today);
  if (held?.shifts.has(`${shift.id}/${validFrom}`)) {
    return null;
  }
  if (!shift.active) {
    fault("shiftName", "SHIFT_RETIRED", row.shiftName);
    return null;
  }
  if (held && !held.active) {
    warn("shiftName", "EMPLOYEE_HAS_LEFT", row.shiftName);
    return null;
  }
  return { shiftId: shift.id, validFrom };
}

// YES records a paper consent for someone holding none; NO never withdraws one (KEHOACH 9.20 rule 3).
function planConsent(row: ImportRow, held: Held | undefined, warn: Note): boolean {
  if (row.consentPaper !== "YES" || held?.consented) {
    return false;
  }
  if (held && !held.active) {
    warn("consentPaper", "EMPLOYEE_HAS_LEFT", row.consentPaper);
    return false;
  }
  return true;
}

// A pair already held is never assigned again: that would send a held face back to RETAKE (KEHOACH 9.20 rule 3).
function planKiosk(
  row: ImportRow,
  held: Held | undefined,
  consenting: boolean,
  input: PlanInput,
  fault: Note,
  warn: Note,
): string | null {
  const kioskId = row.kioskId;
  if (!kioskId) {
    return null;
  }
  const state = held?.kiosks.get(kioskId);
  if (state !== undefined && state !== "REVOKED") {
    return null;
  }
  if (!input.catalogue.approvedKiosks.has(kioskId)) {
    fault("kioskId", "KIOSK_UNKNOWN", kioskId);
    return null;
  }
  if (held && !held.active) {
    warn("kioskId", "EMPLOYEE_HAS_LEFT", kioskId);
    return null;
  }
  if (!held?.consented && !consenting) {
    warn("kioskId", "KIOSK_NO_CONSENT", kioskId);
    return null;
  }
  return kioskId;
}

function planLogin(row: ImportRow, held: Held | undefined, mailing: Set<string>, input: PlanInput, warn: Note): boolean {
  if (row.openLogin !== "YES" || held?.hasLogin) {
    return false;
  }
  if (held && !held.active) {
    warn("openLogin", "EMPLOYEE_HAS_LEFT", row.openLogin);
    return false;
  }
  const email = held ? held.values.personalEmail : row.personalEmail;
  if (!email) {
    warn("openLogin", "LOGIN_NO_EMAIL", row.openLogin);
    return false;
  }
  if (input.takenEmails.has(email) || mailing.has(email)) {
    warn("openLogin", "LOGIN_EMAIL_TAKEN", email);
    return false;
  }
  mailing.add(email);
  return true;
}

/** Drop-down entries become codes, and a "-" leaves the cell empty, so every lookup sees a code or nothing. */
function resolveEntries(raw: ImportRow, catalogue: Catalogue): { row: ImportRow; named: string | null } {
  const kept: ImportRow = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== CLEAR));
  const department = entryOf(kept.departmentCode, catalogue.departmentCodes);
  const row: ImportRow = {
    ...kept,
    legalEntityCode: entryOf(kept.legalEntityCode, new Set(catalogue.entities.keys())).code,
    departmentCode: department.code,
    jobTitleCode: entryOf(kept.jobTitleCode, new Set(catalogue.titles.keys())).code,
    shiftName: entryOf(kept.shiftName, new Set(catalogue.shifts.keys())).code,
    kioskId: entryOf(kept.kioskId, catalogue.approvedKiosks).code,
  };
  for (const column of Object.keys(row) as ImportColumn[]) {
    if (row[column] === undefined) {
      delete row[column];
    }
  }
  return { row, named: department.entity };
}

/**
 * What every line would do, and what stands in its way. The dry run and the
 * write both come through here: a dry run that cannot reach the writes is a
 * dry run that lies about them.
 */
export function planRows(input: PlanInput): Planned {
  const { read, heldBy } = input;
  const faults: RowFault[] = [];
  const warnings: RowFault[] = [];
  const arriving = new Set(read.rows.map((one) => one.code).filter(Boolean));
  const mailing = new Set<string>();
  let payKept = 0;
  const plans = read.rows.map((raw, at): RowPlan => {
    const line = read.lines[at] ?? 0;
    const fault: Note = (column, code, value = "") => faults.push({ row: line, column, code, value });
    const warn: Note = (column, code, value = "") => warnings.push({ row: line, column, code, value });
    const { row, named } = resolveEntries(raw, input.catalogue);
    const held = heldBy.get(row.code ?? "");
    const cleared = held ? clearsOf(raw, held, fault, warn) : [];
    if (!held && !row.fullName) {
      fault("fullName", "VALUE_REQUIRED");
    }
    const keepsDepartment = row.departmentCode === undefined && raw.departmentCode !== CLEAR;
    const place = placeRow(row, named, held, keepsDepartment, input.catalogue, fault);
    if (row.managerCode && !input.managers.has(row.managerCode) && !arriving.has(row.managerCode)) {
      fault("managerCode", "MANAGER_UNKNOWN", row.managerCode);
    }
    if (held) {
      for (const column of BY_REQUEST) {
        if (row[column] !== undefined && row[column] !== held.values[column]) {
          warn(column, "CHANGE_BY_REQUEST", row[column]);
        }
      }
      payKept += row.baseSalary && held.hasPay ? 1 : 0;
    }
    const profile = held
      ? changesOf(row, place, held)
      : IMPORT_COLUMNS.filter((column) => column !== "code" && !EXTRAS.has(column) && row[column] !== undefined);
    const shift = planShift(row, held, input, fault, warn);
    const consent = planConsent(row, held, warn);
    const kiosk = planKiosk(row, held, consent, input, fault, warn);
    const login = planLogin(row, held, mailing, input, warn);
    const extras: ImportColumn[] = [
      ...(shift ? (["shiftName", "shiftFrom"] as const) : []),
      ...(consent ? (["consentPaper"] as const) : []),
      ...(kiosk ? (["kioskId"] as const) : []),
      ...(login ? (["openLogin"] as const) : []),
    ];
    return {
      line,
      row,
      held,
      place,
      fields: [...profile, ...extras],
      cleared,
      writesRecord: !held || [...profile, ...cleared].some((column) => RECORD.has(column)),
      shift,
      consent,
      kiosk,
      login,
    };
  });
  return { plans, faults, warnings, payKept };
}
