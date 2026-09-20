import type { Employee } from "@prisma/client";

/** The columns each change writes, and which changes warn the address on file.
 *  A column outside this map has no path through (KEHOACH 9.17 item 6 rule 1). */
export const PROFILE_FIELDS = {
  PERSONAL_EMAIL: { columns: ["personalEmail"], notice: "PERSONAL_EMAIL" },
  PHONE: { columns: ["phone"], notice: null },
  BANK: { columns: ["bankName", "bankAccount"], notice: "BANK" },
  NATIONAL_ID: { columns: ["nationalId"], notice: null },
  TAX_CODE: { columns: ["taxCode"], notice: null },
  SOCIAL_INSURANCE_NO: { columns: ["socialInsuranceNo"], notice: null },
} as const;

export type ProfileFieldName = keyof typeof PROFILE_FIELDS;

export type ProfileColumn = (typeof PROFILE_FIELDS)[ProfileFieldName]["columns"][number];

export type ProfileValues = Partial<Record<ProfileColumn, string | null>>;

export const PROFILE_FIELD_NAMES = Object.keys(PROFILE_FIELDS) as ProfileFieldName[];

export function heldValues(person: Employee, field: ProfileFieldName): ProfileValues {
  const held: ProfileValues = {};
  for (const column of PROFILE_FIELDS[field].columns) {
    held[column] = person[column];
  }
  return held;
}

/** Every column the field covers, or null when one of them is blank: half a bank account routes nowhere. */
export function askedValues(field: ProfileFieldName, body: ProfileValues): ProfileValues | null {
  const want: ProfileValues = {};
  for (const column of PROFILE_FIELDS[field].columns) {
    const value = body[column];
    if (typeof value !== "string" || value.trim() === "") {
      return null;
    }
    want[column] = value.trim();
  }
  return want;
}

export function sameValues(a: ProfileValues, b: ProfileValues): boolean {
  const columns = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<ProfileColumn>;
  return [...columns].every((column) => (a[column] ?? null) === (b[column] ?? null));
}
