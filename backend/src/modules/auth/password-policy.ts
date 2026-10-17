import { COMMON_PASSWORDS } from "./common-passwords.generated.js";

const COMMON = new Set(COMMON_PASSWORDS);
// Shorter pieces of a name (an, le, vo) sit inside too many passwords that hold no name at all.
const PERSONAL_MIN = 4;

export type PasswordFault = "PASSWORD_COMMON" | "PASSWORD_PERSONAL";

/** The facts about an account a guesser tries first. */
export interface PasswordOwner {
  email: string;
  fullName?: string | null;
  code?: string | null;
}

/** The fault of a new password, or null when it may be set (KEHOACH 9.4). */
export function passwordFault(password: string, owner: PasswordOwner): PasswordFault | null {
  if (COMMON.has(password.toLowerCase())) {
    return "PASSWORD_COMMON";
  }
  const typed = folded(password);
  const pieces = [owner.email.split("@")[0], owner.fullName, owner.code]
    .map((one) => folded(one ?? ""))
    .filter((one) => one.length >= PERSONAL_MIN);
  return pieces.some((one) => typed.includes(one)) ? "PASSWORD_PERSONAL" : null;
}

function folded(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/giu, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
